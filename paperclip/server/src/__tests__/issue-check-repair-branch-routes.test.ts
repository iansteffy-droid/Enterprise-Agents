import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  principalPermissionGrants,
  routineRuns,
  routines,
  workflowBlueprints,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue prepare-for-merge route (check-repair-branch)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-check-repair-branch-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(routineRuns);
    await db.delete(workflowBlueprints);
    await db.delete(issues);
    await db.delete(routines);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null }));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Hygiene Auditor",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      // On-demand wakes are off so the routine run never launches a real adapter.
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      permissions: {},
    });
    const issueId = randomUUID();
    const issueNumber = Math.floor(Math.random() * 1_000_000) + 1;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ready for merge",
      status: "in_review",
      priority: "medium",
      identifier: `REPAIR-${issueNumber}`,
      issueNumber,
    });
    return { companyId, agentId, issueId };
  }

  async function addComment(companyId: string, issueId: string, body: string, createdAt: Date) {
    await db.insert(issueComments).values({ companyId, issueId, body, createdAt, updatedAt: createdAt });
  }

  async function configureRoutine(companyId: string, agentId: string) {
    const [routine] = await db
      .insert(routines)
      .values({ companyId, title: "Prepare for merge", assigneeAgentId: agentId })
      .returning();
    await db.insert(workflowBlueprints).values({ companyId, prepareForMergeRoutineId: routine!.id });
    return routine!;
  }

  it("runs the configured prepare-for-merge routine with the branch from the latest hand-off comment", async () => {
    const { companyId, agentId, issueId } = await seedCompany();
    const routine = await configureRoutine(companyId, agentId);
    await addComment(companyId, issueId, "Submitted.\nBranch: feature/old-name\nHEAD: abc123", new Date(Date.now() - 60_000));
    await addComment(companyId, issueId, "Re-submitted.\nBranch: `feature/ACME-7-export`\nHEAD: def456", new Date(Date.now() - 30_000));
    await addComment(companyId, issueId, "A later comment without a branch line.", new Date());

    const res = await request(createApp(companyId)).post(`/api/issues/${issueId}/check-repair-branch`).send({});

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, branch: "feature/ACME-7-export" });
    const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id));
    expect(runs).toHaveLength(1);
    const payload = JSON.stringify(runs[0]!.triggerPayload);
    expect(payload).toContain("REPAIR-");
    expect(payload).toContain("feature/ACME-7-export");
    expect(payload).not.toContain("pc/");
    expect(payload).not.toContain("branchPattern");
  });

  it("returns 422 prepare_for_merge_branch_unknown when no comment names a branch", async () => {
    const { companyId, agentId, issueId } = await seedCompany();
    await configureRoutine(companyId, agentId);
    await addComment(companyId, issueId, "Looks good. The branch is somewhere.", new Date());

    const res = await request(createApp(companyId)).post(`/api/issues/${issueId}/check-repair-branch`).send({});

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "prepare_for_merge_branch_unknown" });
    expect(await db.select().from(routineRuns)).toHaveLength(0);
  });

  it("returns 422 prepare_for_merge_not_configured when the blueprint has no routine", async () => {
    const { companyId, issueId } = await seedCompany();
    await db.insert(workflowBlueprints).values({ companyId });

    const res = await request(createApp(companyId)).post(`/api/issues/${issueId}/check-repair-branch`).send({});

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "prepare_for_merge_not_configured" });
    expect(await db.select().from(routineRuns)).toHaveLength(0);
  });

  it("returns 422 prepare_for_merge_not_configured when the routine belongs to another company", async () => {
    const { companyId, issueId } = await seedCompany();
    const other = await seedCompany();
    const [foreign] = await db
      .insert(routines)
      .values({ companyId: other.companyId, title: "Foreign", assigneeAgentId: other.agentId })
      .returning();
    await db.insert(workflowBlueprints).values({ companyId, prepareForMergeRoutineId: foreign!.id });

    const res = await request(createApp(companyId)).post(`/api/issues/${issueId}/check-repair-branch`).send({});

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "prepare_for_merge_not_configured" });
    expect(await db.select().from(routineRuns)).toHaveLength(0);
  });

  it("returns 422 prepare_for_merge_not_configured when the company has no blueprint row", async () => {
    const { companyId, issueId } = await seedCompany();

    const res = await request(createApp(companyId)).post(`/api/issues/${issueId}/check-repair-branch`).send({});

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "prepare_for_merge_not_configured" });
  });
});
