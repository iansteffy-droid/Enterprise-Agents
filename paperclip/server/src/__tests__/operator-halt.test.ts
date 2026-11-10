import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issues,
  workflowBlueprints,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import type { IssueExecutionState } from "@paperclipai/shared";
import { DEFAULT_WORKFLOW_HALT_PHRASES } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../services/issue-execution-policy.ts";
import {
  DEFAULT_HALT_PHRASES,
  OPERATOR_ACTION_PREFIX,
  buildOperatorHaltState,
  detectOperatorHalt,
} from "../services/operator-halt.ts";
import { reconstructChain } from "../services/workflow-adherence.ts";

describe("detectOperatorHalt", () => {
  it("defaults to the shared halt phrases", () => {
    expect(DEFAULT_HALT_PHRASES).toEqual(DEFAULT_WORKFLOW_HALT_PHRASES);
  });

  it.each([
    ["Done and merged, thanks", "done and merged"],
    ["done.", "done"],
    ["MERGED", "merged"],
    ["stop — I'll take it from here", "stop"],
    ["stop - I'll take it from here", "stop"],
    ["Done; closing", "done"],
    ["halt: wrong branch", "halt"],
    ["merged and deployed", "merged"],
    ["\n\n  Cancel!  \nsecond line", "cancel"],
    ["done 🎉", "done"],
  ])("halts on %j", (body, phrase) => {
    expect(detectOperatorHalt(body, DEFAULT_HALT_PHRASES)).toBe(phrase);
  });

  it.each([
    "Done? Not yet",
    "done?",
    "I'm not done reviewing",
    "Donetsk office",
    "please merge after fixing X",
    "doneness check",
    "Looks good\ndone",
    "",
    "   \n  ",
  ])("does not halt on %j", (body) => {
    expect(detectOperatorHalt(body, DEFAULT_HALT_PHRASES)).toBeNull();
  });

  it("uses only the phrases it is given", () => {
    expect(detectOperatorHalt("ship it", ["Ship it"])).toBe("ship it");
    expect(detectOperatorHalt("done", ["ship it"])).toBeNull();
    expect(detectOperatorHalt("done", [])).toBeNull();
  });

  it("buildOperatorHaltState keeps the stage pointers and records an operator hold", () => {
    const state: IssueExecutionState = {
      status: "pending",
      currentStageId: "11111111-1111-4111-8111-111111111111",
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222", userId: null },
      returnAssignee: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333", userId: null },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };
    expect(buildOperatorHaltState(state, "merged")).toEqual({
      ...state,
      status: "held",
      lastDecisionOutcome: "held",
      hold: { reason: "merged", resumeAt: null, heldBy: "operator" },
    });
  });

  it("a hold handed to the operator and resumed adds no backward edge to the adherence chain", () => {
    // The assignee goes qa -> (board user: no agent holder) -> qa; the chain collapses to one touch.
    const chain = reconstructChain([
      { agentId: "dev", t: 1 },
      { agentId: "qa", t: 2 },
      { agentId: "qa", t: 3 },
    ]);
    expect(chain.map((touch) => touch.agentId)).toEqual(["dev", "qa"]);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres operator halt tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("hold state and operator halt (issue routes, real DB)", () => {
  const BOARD_USER_ID = "board-user-1";
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-operator-halt-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(workflowBlueprints);
    await db.delete(companyMemberships);
    await vi.waitFor(async () => {
      await db.delete(agentWakeupRequests);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
    });
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type Actor = Express.Request["actor"];

  function boardActor(companyId: string): Actor {
    return {
      type: "board",
      userId: BOARD_USER_ID,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
      source: "local_implicit",
    };
  }

  function agentActor(companyId: string, agentId: string): Actor {
    return { type: "agent", agentId, companyId, runId: null, source: "agent_jwt" };
  }

  function app(actor: Actor) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    server.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null }));
    server.use(errorHandler);
    return server;
  }

  async function seed(options: { haltPhrases?: string[] | null; blueprint?: boolean } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Hold Co",
      issuePrefix: `H${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    const ids = { dev: randomUUID(), qa: randomUUID() };
    await db.insert(agents).values(
      Object.entries(ids).map(([name, id]) => ({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        // On-demand wakes are off so no adapter ever launches.
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        permissions: { canCreateAgents: false },
      })),
    );
    if (options.blueprint) {
      await db.insert(workflowBlueprints).values({ companyId, haltPhrases: options.haltPhrases ?? null });
    }
    return { companyId, ...ids };
  }

  async function seedActiveReview(options: Parameters<typeof seed>[0] = {}) {
    const co = await seed(options);
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: co.qa }] },
        { type: "approval", participants: [{ type: "user", userId: BOARD_USER_ID }] },
      ],
    })!;
    const stageId = policy.stages[0]!.id;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: co.companyId,
      title: "Reviewable",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: co.qa,
      issueNumber: 1,
      identifier: `HOLD-${issueId.slice(0, 4)}`,
      executionPolicy: policy as any,
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: co.qa, userId: null },
        returnAssignee: { type: "agent", agentId: co.dev, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      } as any,
    });
    return { co, issueId, stageId };
  }

  async function readIssue(issueId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    return row!;
  }

  async function decisionsFor(issueId: string) {
    return db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issueId));
  }

  async function commentsFor(issueId: string) {
    return db.select().from(issueComments).where(eq(issueComments.issueId, issueId)).orderBy(issueComments.createdAt);
  }

  function postComment(actor: Actor, issueId: string, body: string) {
    return request(app(actor)).post(`/api/issues/${issueId}/comments`).send({ body });
  }

  it("board comment 'merged' on a pending-stage issue halts: executionState.status=held, assignee=board user, status=in_review, system comment posted, no agent wake", async () => {
    const { co, issueId, stageId } = await seedActiveReview();
    const res = await postComment(boardActor(co.companyId), issueId, "Merged, thanks");
    expect(res.status).toBe(201);

    const row = await readIssue(issueId);
    expect(row.status).toBe("in_review");
    expect(row.assigneeAgentId).toBeNull();
    expect(row.assigneeUserId).toBe(BOARD_USER_ID);
    expect(parseIssueExecutionState(row.executionState)).toMatchObject({
      status: "held",
      currentStageId: stageId,
      currentParticipant: { type: "agent", agentId: co.qa },
      hold: { reason: "merged", resumeAt: null, heldBy: "operator" },
    });

    const comments = await commentsFor(issueId);
    const system = comments.find((comment) => comment.authorType === "system");
    expect(system?.body.startsWith(`${OPERATOR_ACTION_PREFIX} merged`)).toBe(true);

    const decisions = await decisionsFor(issueId);
    expect(decisions.map((decision) => [decision.outcome, decision.actorUserId])).toEqual([["held", BOARD_USER_ID]]);

    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activity.map((entry) => entry.action)).toContain("issue.execution_held");

    await new Promise((resolve) => setTimeout(resolve, 200));
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, co.qa));
    expect(wakes).toEqual([]);
  });

  it("board comment that merely contains a halt word does not halt", async () => {
    const { co, issueId } = await seedActiveReview();
    for (const body of ["Done? Not yet", "I'm not done reviewing"]) {
      const res = await postComment(boardActor(co.companyId), issueId, body);
      expect(res.status).toBe(201);
    }
    const row = await readIssue(issueId);
    expect(row.assigneeAgentId).toBe(co.qa);
    expect(parseIssueExecutionState(row.executionState)?.status).toBe("pending");
  });

  it("uses the blueprint row's halt_phrases instead of the default", async () => {
    const { co, issueId } = await seedActiveReview({ blueprint: true, haltPhrases: ["ship it"] });
    await postComment(boardActor(co.companyId), issueId, "done");
    expect(parseIssueExecutionState((await readIssue(issueId)).executionState)?.status).toBe("pending");
    await postComment(boardActor(co.companyId), issueId, "Ship it.");
    expect(parseIssueExecutionState((await readIssue(issueId)).executionState)).toMatchObject({
      status: "held",
      hold: { reason: "ship it", heldBy: "operator" },
    });
  });

  it("falls back to the default phrases when the blueprint row has no halt_phrases", async () => {
    const { co, issueId } = await seedActiveReview({ blueprint: true, haltPhrases: null });
    await postComment(boardActor(co.companyId), issueId, "stop");
    expect(parseIssueExecutionState((await readIssue(issueId)).executionState)?.status).toBe("held");
  });

  it("agent comment 'done' never halts", async () => {
    const { co, issueId } = await seedActiveReview();
    // The stage participant itself; agents can only comment on issues they hold.
    const res = await postComment(agentActor(co.companyId, co.qa), issueId, "done");
    expect(res.status).toBe(201);
    const row = await readIssue(issueId);
    expect(parseIssueExecutionState(row.executionState)?.status).toBe("pending");
    expect(row.assigneeAgentId).toBe(co.qa);
  });

  it("board comment on an issue without executionState is unaffected", async () => {
    const co = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: co.companyId,
      title: "Plain",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: co.dev,
      issueNumber: 1,
      identifier: "PLAIN-1",
    });
    const res = await postComment(boardActor(co.companyId), issueId, "done");
    expect(res.status).toBe(201);
    const row = await readIssue(issueId);
    expect(row.status).toBe("in_progress");
    expect(row.assigneeAgentId).toBe(co.dev);
    expect(row.executionState).toBeNull();
  });

  it("agent PATCH on a held issue returns 422 execution_held", async () => {
    const { co, issueId } = await seedActiveReview();
    await postComment(boardActor(co.companyId), issueId, "halt");
    for (const agentId of [co.qa, co.dev]) {
      const res = await request(app(agentActor(co.companyId, agentId)))
        .patch(`/api/issues/${issueId}`)
        .send({ executionDecision: "approve", comment: "Looks good" });
      expect(res.status).toBe(422);
      expect(res.body.details).toMatchObject({ code: "execution_held" });
    }
    expect(parseIssueExecutionState((await readIssue(issueId)).executionState)?.status).toBe("held");
  });

  it("board PATCH status=in_review resumes at the same stage and reassigns the stage participant", async () => {
    const { co, issueId, stageId } = await seedActiveReview();
    await postComment(boardActor(co.companyId), issueId, "stop — let me check");
    const res = await request(app(boardActor(co.companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });
    expect(res.status).toBe(200);
    const row = await readIssue(issueId);
    expect(row.status).toBe("in_review");
    expect(row.assigneeAgentId).toBe(co.qa);
    expect(row.assigneeUserId).toBeNull();
    expect(parseIssueExecutionState(row.executionState)).toMatchObject({
      status: "pending",
      currentStageId: stageId,
      currentParticipant: { type: "agent", agentId: co.qa },
      hold: null,
    });
    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activity.map((entry) => entry.action)).toContain("issue.execution_hold_resumed");
  });

  it("a halt while changes are requested resumes to the author, not the reviewer", async () => {
    const { co, issueId, stageId } = await seedActiveReview();
    // The reviewer requested changes: the issue is back with its author.
    await db
      .update(issues)
      .set({
        status: "in_progress",
        assigneeAgentId: co.dev,
        executionState: {
          ...(parseIssueExecutionState((await readIssue(issueId)).executionState) as IssueExecutionState),
          status: "changes_requested",
          lastDecisionOutcome: "changes_requested",
        } as any,
      })
      .where(eq(issues.id, issueId));

    await postComment(boardActor(co.companyId), issueId, "halt");
    const halted = await readIssue(issueId);
    expect(parseIssueExecutionState(halted.executionState)).toMatchObject({
      status: "held",
      hold: { heldBy: "operator", resumeStatus: "changes_requested" },
    });

    const res = await request(app(boardActor(co.companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });
    expect(res.status).toBe(200);
    const row = await readIssue(issueId);
    expect(row.status).toBe("in_progress");
    expect(row.assigneeAgentId).toBe(co.dev);
    expect(row.assigneeUserId).toBeNull();
    expect(parseIssueExecutionState(row.executionState)).toMatchObject({
      status: "changes_requested",
      currentStageId: stageId,
      currentParticipant: { type: "agent", agentId: co.qa },
      returnAssignee: { type: "agent", agentId: co.dev },
      lastDecisionOutcome: "changes_requested",
      hold: null,
    });
  });

  it("a halt from pending records no resume status (the resume returns to the reviewer, above)", async () => {
    const { co, issueId } = await seedActiveReview();
    await postComment(boardActor(co.companyId), issueId, "halt");
    const held = parseIssueExecutionState((await readIssue(issueId)).executionState);
    expect(held?.hold?.resumeStatus ?? null).toBeNull();
  });

  // Intake: never left intake, no chain. Board-ungated: a board user's explicit null policy
  // (leftIntakeAt cleared, executionPolicyUngatedAt set), so no chain either.
  async function seedUngatedTopLevel(options: { boardUngated: boolean }) {
    const co = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: co.companyId,
      title: options.boardUngated ? "Board-ungated feature" : "Still in intake",
      status: "todo",
      priority: "medium",
      assigneeAgentId: co.dev,
      issueNumber: 1,
      identifier: `UNG-${issueId.slice(0, 4)}`,
      leftIntakeAt: null,
      executionPolicyUngatedAt: options.boardUngated ? new Date() : null,
      executionPolicy: null,
      executionState: null,
    });
    return { co, issueId };
  }

  for (const boardUngated of [false, true]) {
    it(`an agent's executionDecision on a top-level issue with no execution policy (${boardUngated ? "board-ungated" : "intake"}) is 422 execution_decision_without_stage`, async () => {
      const { co, issueId } = await seedUngatedTopLevel({ boardUngated });
      for (const decision of ["approve", "request_changes", "hold"]) {
        const res = await request(app(agentActor(co.companyId, co.dev)))
          .patch(`/api/issues/${issueId}`)
          .send({ status: decision === "approve" ? "done" : undefined, executionDecision: decision, comment: "Looks good" });
        expect(res.status).toBe(422);
        expect(res.body.details).toMatchObject({ code: "execution_decision_without_stage" });
      }
      const row = await readIssue(issueId);
      expect(row.status).toBe("todo");
      expect(await decisionsFor(issueId)).toEqual([]);
    });
  }

  it("an agent's executionDecision while no stage is active (changes requested) is 422 execution_decision_without_stage", async () => {
    const { co, issueId } = await seedActiveReview();
    // status todo (not in_progress) so the agent's PATCH needs no checkout run in this harness.
    await db
      .update(issues)
      .set({
        status: "todo",
        assigneeAgentId: co.dev,
        executionState: {
          ...(parseIssueExecutionState((await readIssue(issueId)).executionState) as IssueExecutionState),
          status: "changes_requested",
        } as any,
      })
      .where(eq(issues.id, issueId));
    const res = await request(app(agentActor(co.companyId, co.dev)))
      .patch(`/api/issues/${issueId}`)
      .send({ executionDecision: "approve", comment: "Approving my own fix" });
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "execution_decision_without_stage" });
  });

  it("an agent's untimed hold hands the issue to the operator with an 'Operator action needed:' comment", async () => {
    const { co, issueId, stageId } = await seedActiveReview();
    const res = await request(app(agentActor(co.companyId, co.qa)))
      .patch(`/api/issues/${issueId}`)
      .send({ executionDecision: "hold", comment: "Staging credentials expired; cannot run the suite" });
    expect(res.status).toBe(200);
    const row = await readIssue(issueId);
    expect(row.status).toBe("in_review");
    expect(row.assigneeAgentId).toBeNull();
    expect(row.assigneeUserId).toBe(BOARD_USER_ID);
    expect(parseIssueExecutionState(row.executionState)).toMatchObject({
      status: "held",
      currentStageId: stageId,
      hold: {
        reason: "Staging credentials expired; cannot run the suite",
        resumeAt: null,
        heldBy: "participant",
      },
    });
    const comments = await commentsFor(issueId);
    expect(comments.map((comment) => comment.body)).toEqual([
      "Operator action needed: Staging credentials expired; cannot run the suite",
    ]);
    const decisions = await decisionsFor(issueId);
    expect(decisions.map((decision) => [decision.outcome, decision.actorAgentId])).toEqual([["held", co.qa]]);
  });

  it("an agent's timed hold keeps the assignee and stage and records a held decision", async () => {
    const { co, issueId, stageId } = await seedActiveReview();
    const resumeAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const res = await request(app(agentActor(co.companyId, co.qa)))
      .patch(`/api/issues/${issueId}`)
      .send({ executionDecision: "hold", status: "in_review", holdResumeAt: resumeAt, comment: "CI is running" });
    expect(res.status).toBe(200);
    const row = await readIssue(issueId);
    expect(row.assigneeAgentId).toBe(co.qa);
    expect(parseIssueExecutionState(row.executionState)).toMatchObject({
      status: "held",
      currentStageId: stageId,
      hold: { reason: "CI is running", resumeAt, heldBy: "participant" },
    });
    expect((await decisionsFor(issueId)).map((decision) => decision.outcome)).toEqual(["held"]);
  });

  it("an agent's hold paired with a status other than in_review is a mismatch", async () => {
    const { co, issueId } = await seedActiveReview();
    const res = await request(app(agentActor(co.companyId, co.qa)))
      .patch(`/api/issues/${issueId}`)
      .send({ executionDecision: "hold", status: "done", comment: "CI is running" });
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "execution_decision_status_mismatch" });
  });

  it("the board's done override still completes a held issue", async () => {
    const { co, issueId } = await seedActiveReview();
    await postComment(boardActor(co.companyId), issueId, "done");
    const res = await request(app(boardActor(co.companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });
    expect(res.status).toBe(200);
    const row = await readIssue(issueId);
    expect(row.status).toBe("done");
    expect(parseIssueExecutionState(row.executionState)?.status).toBe("completed");
  });
});

describeEmbeddedPostgres("timed hold re-wake (issue-monitor scheduler, real DB)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-hold-scheduler-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function waitForHeartbeatSideEffectsSettled(timeoutMs = 5_000, quietMs = 500) {
    const fingerprint = async () => {
      const [active, events, activity] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)` })
          .from(heartbeatRuns)
          .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`),
        db.select({ count: sql<number>`count(*)` }).from(heartbeatRunEvents),
        db.select({ count: sql<number>`count(*)` }).from(activityLog),
      ]);
      return [active[0]?.count ?? 0, events[0]?.count ?? 0, activity[0]?.count ?? 0].join(":");
    };
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const current = await fingerprint();
      const activeCount = Number(current.split(":")[0] ?? 0);
      if (current !== previous || activeCount > 0) {
        previous = current;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for hold re-wake side effects to settle");
  }

  afterEach(async () => {
    await waitForHeartbeatSideEffectsSettled();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("a timed hold whose resumeAt is already in the past re-wakes the same participant on the next scheduler tick and records no bounce", async () => {
    const companyId = randomUUID();
    const devId = randomUUID();
    const qaId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Hold Co", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values(
      [
        { id: devId, name: "Dev" },
        { id: qaId, name: "QA" },
      ].map((agent) => ({
        ...agent,
        companyId,
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
        permissions: {},
      })),
    );
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: qaId }] }],
    })!;
    const stageId = policy.stages[0]!.id;
    const decisionId = randomUUID();
    const resumeAt = "2026-04-11T12:30:00.000Z";
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Waiting on CI",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: qaId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: policy as any,
      executionState: {
        status: "held",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaId, userId: null },
        returnAssignee: { type: "agent", agentId: devId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: decisionId,
        lastDecisionOutcome: "held",
        hold: { reason: "CI is running", resumeAt, heldBy: "participant" },
      } as any,
    });
    await db.insert(issueExecutionDecisions).values({
      id: decisionId,
      companyId,
      issueId,
      stageId,
      stageType: "review",
      actorAgentId: qaId,
      outcome: "held",
      body: "CI is running",
    });

    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    const result = await heartbeat.tickTimers(tickAt);
    expect(result.enqueued).toBe(1);

    const row = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(row.status).toBe("in_review");
    expect(row.assigneeAgentId).toBe(qaId);
    expect(parseIssueExecutionState(row.executionState)).toMatchObject({
      status: "pending",
      currentStageId: stageId,
      currentParticipant: { type: "agent", agentId: qaId },
      hold: null,
    });

    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "execution_hold_resumed")));
    expect(wakes.map((wake) => wake.agentId)).toEqual([qaId]);
    // The same execution-stage context a board resume carries.
    const executionStage = {
      wakeRole: "reviewer",
      stageId,
      stageType: "review",
      currentParticipant: { type: "agent", agentId: qaId },
      returnAssignee: { type: "agent", agentId: devId },
      allowedActions: ["approve", "request_changes", "hold"],
    };
    expect(wakes[0]?.payload).toMatchObject({ issueId, resumeAt, executionStage });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, qaId));
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.contextSnapshot).toMatchObject({ issueId, wakeReason: "execution_hold_resumed", executionStage });

    // No bounce: the only decision on the issue is the hold itself.
    const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions.map((decision) => decision.outcome)).toEqual(["held"]);

    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activity.map((entry) => entry.action)).toContain("issue.execution_hold_resumed");

    // The next tick finds nothing to resume.
    const second = await heartbeat.tickTimers(new Date("2026-04-11T12:32:00.000Z"));
    expect(second.enqueued).toBe(0);
  });
});
