import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  issueExecutionDecisions,
  issues,
  principalPermissionGrants,
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

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution decision route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GET /api/issues/:id/execution-decisions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-decisions-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueExecutionDecisions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string, userId = "board-user-1") {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany(userId = "board-user-1") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: userId,
      membershipRole: "owner",
      grantedByUserId: null,
    });
    return companyId;
  }

  it("lists the issue's decisions in createdAt order with outcome, stage, actor, body and run", async () => {
    const companyId = await seedCompany();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const stageA = randomUUID();
    const stageB = randomUUID();
    await db.insert(agents).values({
      id: reviewerId,
      companyId,
      name: "Reviewer",
      role: "qa",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Gated", status: "in_review", priority: "medium" },
      { id: otherIssueId, companyId, title: "Other", status: "todo", priority: "medium" },
    ]);
    await db.insert(issueExecutionDecisions).values([
      {
        companyId,
        issueId,
        stageId: stageB,
        stageType: "approval",
        actorAgentId: reviewerId,
        outcome: "approved",
        body: "second",
        createdAt: new Date("2026-11-02T00:00:00.000Z"),
      },
      {
        companyId,
        issueId,
        stageId: stageA,
        stageType: "review",
        actorUserId: "board-user-1",
        outcome: "changes_requested",
        body: "first",
        createdAt: new Date("2026-11-01T00:00:00.000Z"),
      },
      {
        companyId,
        issueId: otherIssueId,
        stageId: stageA,
        stageType: "review",
        outcome: "approved",
        body: "other issue",
      },
    ]);

    const res = await request(createApp(companyId)).get(`/api/issues/${issueId}/execution-decisions`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      issueId,
      stageId: stageA,
      stageType: "review",
      outcome: "changes_requested",
      actorAgentId: null,
      actorUserId: "board-user-1",
      body: "first",
      createdByRunId: null,
    });
    expect(res.body[1]).toMatchObject({
      stageId: stageB,
      stageType: "approval",
      outcome: "approved",
      actorAgentId: reviewerId,
      body: "second",
    });
  });

  it("refuses an actor from another company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany("board-user-2");
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Gated", status: "todo", priority: "medium" });

    const res = await request(createApp(otherCompanyId, "board-user-2")).get(`/api/issues/${issueId}/execution-decisions`);

    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown issue", async () => {
    const companyId = await seedCompany();
    const res = await request(createApp(companyId)).get(`/api/issues/${randomUUID()}/execution-decisions`);
    expect(res.status).toBe(404);
  });
});
