import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { BOUNCE_OUTCOME, computeRetroMetrics } from "../services/retro-metrics.ts";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("computeRetroMetrics", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-retro-metrics-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(costEvents);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const T = (minute: number) => new Date(Date.UTC(2026, 10, 9, 10, minute, 0));

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co" });
    const agentA = randomUUID();
    const agentB = randomUUID();
    await db.insert(agents).values([
      { id: agentA, companyId, name: "Alpha", role: "engineer" },
      { id: agentB, companyId, name: "Bravo", role: "qa" },
    ]);
    const root = randomUUID();
    const child = randomUUID();
    const grandchild = randomUUID();
    const unrelated = randomUUID();
    await db.insert(issues).values([
      { id: root, companyId, title: "Root", identifier: "T-1", issueNumber: 1, status: "done", completedAt: T(60) },
      { id: child, companyId, title: "Child", identifier: "T-2", issueNumber: 2, parentId: root },
      { id: grandchild, companyId, title: "Grandchild", identifier: "T-3", issueNumber: 3, parentId: child },
      { id: unrelated, companyId, title: "Other", identifier: "T-4", issueNumber: 4 },
    ]);

    async function run(
      agentId: string,
      issueId: string,
      status: string,
      startMinute: number,
      extra: Partial<typeof heartbeatRuns.$inferInsert> = {},
      wakeReason = "issue_assigned",
    ) {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId,
        status,
        startedAt: T(startMinute),
        finishedAt: T(startMinute + 1),
        contextSnapshot: { issueId, wakeReason },
        ...extra,
      });
      return id;
    }

    // A succeeds on the child, then B bounces it: A is the agent that caused that bounce.
    const r1 = await run(agentA, child, "succeeded", 1);
    // A fails on the grandchild, but a status change shows the run did something.
    const r2 = await run(agentA, grandchild, "failed", 3);
    const r3 = await run(agentB, child, "timed_out", 5);
    const r4 = await run(agentB, root, "succeeded", 10);
    const r5 = await run(agentB, grandchild, "cancelled", 12);
    // The missing-comment retry: succeeded, but produced nothing.
    const r6 = await run(agentA, child, "succeeded", 20, { invocationSource: "automation" }, "missing_issue_comment");
    // Outside the tree: must not be counted anywhere.
    const rOut = await run(agentA, unrelated, "failed", 30);

    await db.insert(issueComments).values({
      companyId,
      issueId: child,
      authorAgentId: agentA,
      createdByRunId: r1,
      body: "Implemented.",
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentA,
      action: "issue.updated",
      entityType: "issue",
      entityId: grandchild,
      agentId: agentA,
      runId: r2,
      details: { status: "blocked", _previous: { status: "todo" } },
    });

    const stage = randomUUID();
    await db.insert(issueExecutionDecisions).values([
      // bounce: B asks A for changes on the child, after r1 finished
      { companyId, issueId: child, stageId: stage, stageType: "review", actorAgentId: agentB, outcome: "changes_requested", body: "Fix it", createdAt: T(6) },
      // approval carrying a finding
      { companyId, issueId: root, stageId: stage, stageType: "approval", actorAgentId: agentB, outcome: "approved", body: "Looks good.\nNitpick: rename x", createdByRunId: r4, createdAt: T(11) },
      // approval by a user, no finding
      { companyId, issueId: root, stageId: stage, stageType: "approval", actorUserId: "user-1", outcome: "approved", body: "LGTM", createdAt: T(50) },
      // held is NOT a bounce, even with a request-changes-looking body
      { companyId, issueId: grandchild, stageId: stage, stageType: "review", actorAgentId: agentB, outcome: "held", body: "Hold: changes requested upstream", createdAt: T(13) },
    ]);

    await db.insert(costEvents).values([
      { companyId, agentId: agentA, issueId: child, heartbeatRunId: r1, provider: "p", model: "m", costCents: 50, occurredAt: T(2) },
      { companyId, agentId: agentB, issueId: root, heartbeatRunId: r4, provider: "p", model: "m", costCents: 30, occurredAt: T(11) },
      { companyId, agentId: agentA, issueId: unrelated, heartbeatRunId: rOut, provider: "p", model: "m", costCents: 999, occurredAt: T(31) },
    ]);

    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: child,
      kind: "missing_disposition",
      cause: "test",
      fingerprint: "fp-1",
      nextAction: "look",
    });

    // Reviewer B's own earlier succeeded run on the child, between A's run and the bounce:
    // it must not be mistaken for the author.
    await run(agentB, child, "succeeded", 4);
    // Hidden descendant with a run and cost that must be excluded.
    const hidden = randomUUID();
    await db.insert(issues).values({ id: hidden, companyId, title: "Hidden", identifier: "T-5", issueNumber: 5, parentId: root, hiddenAt: T(0) });
    const rHidden = await run(agentA, hidden, "failed", 40);
    await db.insert(costEvents).values({ companyId, agentId: agentA, issueId: hidden, heartbeatRunId: rHidden, provider: "p", model: "m", costCents: 777, occurredAt: T(41) });

    return { hidden, companyId, agentA, agentB, root, child, grandchild, unrelated, r1, r3, r6 };
  }

  it("defines a bounce as a changes_requested decision, once", () => {
    expect(BOUNCE_OUTCOME).toBe("changes_requested");
  });

  it("computes per-agent and total metrics over a tree two levels deep", async () => {
    const s = await seed();
    const m = await computeRetroMetrics(db, s.companyId, s.root);

    expect(m.rootIssueId).toBe(s.root);
    expect(m.rootIdentifier).toBe("T-1");
    expect([...m.issueIds].sort()).toEqual([s.root, s.child, s.grandchild].sort());
    expect(m.firstRunAt).toBe(T(1).toISOString());
    expect(m.doneAt).toBe(T(60).toISOString());

    expect(m.totals).toEqual({
      runs: 7,
      costCents: 80,
      decisions: 4,
      bounces: 1,
      cancelledRuns: 1,
      wastedWakes: 4,
      recoveryActions: 1,
      missingCommentRetries: 1,
    });

    const a = m.agents.find((x) => x.agentId === s.agentA)!;
    const b = m.agents.find((x) => x.agentId === s.agentB)!;
    expect(a).toMatchObject({
      agentName: "Alpha",
      runs: 3,
      failedRuns: 1,
      timedOutRuns: 0,
      cancelledRuns: 0,
      costCents: 50,
      decisions: 0,
      changesRequestedIssued: 0,
      approvalsWithFindings: 0,
      changesRequestedReceived: 1,
      wastedWakes: 1,
    });
    expect(a.wakeReasons).toEqual({ issue_assigned: 2, missing_issue_comment: 1 });
    expect(b).toMatchObject({
      agentName: "Bravo",
      runs: 4,
      failedRuns: 0,
      timedOutRuns: 1,
      cancelledRuns: 1,
      costCents: 30,
      decisions: 3,
      changesRequestedIssued: 1,
      approvalsWithFindings: 1,
      changesRequestedReceived: 0,
      wastedWakes: 3,
    });

    expect(m.bounceTimeline).toEqual([
      {
        issueIdentifier: "T-2",
        stageType: "review",
        actorName: "Bravo",
        outcome: "changes_requested",
        createdAt: T(6).toISOString(),
      },
    ]);
  });

  it("never counts held decisions as bounces", async () => {
    const s = await seed();
    const m = await computeRetroMetrics(db, s.companyId, s.root);
    const b = m.agents.find((x) => x.agentId === s.agentB)!;
    // B has 3 decisions (changes_requested, approved, held); only one is a bounce.
    expect(b.decisions).toBe(3);
    expect(b.changesRequestedIssued).toBe(1);
    expect(m.totals.bounces).toBe(1);
    expect(m.bounceTimeline.map((e) => e.outcome)).toEqual(["changes_requested"]);
  });

  it("excludes hidden descendants with their runs and costs", async () => {
    const s = await seed();
    const m = await computeRetroMetrics(db, s.companyId, s.root);
    expect(m!.issueIds).not.toContain(s.hidden);
    expect(m!.totals.costCents).toBe(80);
    expect(m!.agents.find((x) => x.agentId === s.agentA)!.failedRuns).toBe(1);
    expect(await computeRetroMetrics(db, s.companyId, s.hidden)).toBeNull();
  });

  it("attributes the bounce to the author, not the reviewer's own earlier run", async () => {
    const s = await seed();
    const m = await computeRetroMetrics(db, s.companyId, s.root);
    expect(m!.agents.find((x) => x.agentId === s.agentA)!.changesRequestedReceived).toBe(1);
    expect(m!.agents.find((x) => x.agentId === s.agentB)!.changesRequestedReceived).toBe(0);
  });

  it("prefers the return assignee recorded when it was the last decision", async () => {
    const s = await seed();
    const decision = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.outcome, "changes_requested"))
      .then((rows) => rows[0]!);
    await db
      .update(issues)
      .set({ executionState: { lastDecisionId: decision.id, returnAssignee: { type: "agent", agentId: s.agentB } } })
      .where(eq(issues.id, s.child));
    const m = await computeRetroMetrics(db, s.companyId, s.root);
    expect(m!.agents.find((x) => x.agentId === s.agentB)!.changesRequestedReceived).toBe(1);
    expect(m!.agents.find((x) => x.agentId === s.agentA)!.changesRequestedReceived).toBe(0);
  });

  it("scopes to the subtree of the requested issue", async () => {
    const s = await seed();
    const m = await computeRetroMetrics(db, s.companyId, s.child);
    expect([...m.issueIds].sort()).toEqual([s.child, s.grandchild].sort());
    expect(m.totals.bounces).toBe(1);
    expect(m.totals.decisions).toBe(2);
  });

  it("returns null for a missing root or a root in another company", async () => {
    const s = await seed();
    expect(await computeRetroMetrics(db, s.companyId, randomUUID())).toBeNull();
    expect(await computeRetroMetrics(db, randomUUID(), s.root)).toBeNull();
  });
});
