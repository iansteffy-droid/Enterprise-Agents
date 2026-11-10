import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueExecutionDecisions,
  issues,
  retroTriggers,
  routineRuns,
  routines,
  workflowBlueprints,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { maybeTriggerRetro } from "../services/retro-trigger.ts";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../middleware/logger.js", () => ({ logger: { warn: logWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("maybeTriggerRetro", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let issueSeq = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-retro-trigger-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(retroTriggers);
    await db.delete(issueExecutionDecisions);
    await db.delete(heartbeatRuns);
    await db.delete(routineRuns);
    await db.delete(issues);
    await db.delete(workflowBlueprints);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(retro: Record<string, unknown> | null = {}) {
    const companyId = randomUUID();
    const prefix = `R${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Test Co", issuePrefix: prefix });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Alpha", role: "engineer" });
    const routineId = randomUUID();
    await db.insert(routines).values({ id: routineId, companyId, title: "Retro", assigneeAgentId: agentId });
    if (retro) {
      await db.insert(workflowBlueprints).values({
        companyId,
        retro: { routineId, autoTrigger: true, bounceThreshold: 2, cooldownHours: 24, ...retro } as never,
      });
    }
    const rootId = randomUUID();
    const childId = randomUUID();
    await db.insert(issues).values([
      { id: rootId, companyId, title: "Feature", identifier: `${prefix}-1`, issueNumber: ++issueSeq, status: "in_progress" },
      { id: childId, companyId, title: "Sub", identifier: `${prefix}-2`, issueNumber: ++issueSeq, parentId: rootId },
    ]);
    return { companyId, agentId, routineId, rootId, childId, rootIdentifier: `${prefix}-1` };
  }

  // Stand-in for routineService.runRoutine: records the run row and the issue it creates, like the real one.
  function makeRunner(ctx: { companyId: string; routineId: string }) {
    return vi.fn(async (routineId: string, input: { variables?: Record<string, unknown> | null; idempotencyKey?: string | null }) => {
      const [run] = await db
        .insert(routineRuns)
        .values({
          companyId: ctx.companyId,
          routineId,
          source: "api",
          status: "issue_created",
          idempotencyKey: input.idempotencyKey ?? null,
          triggerPayload: { variables: input.variables ?? {} },
        })
        .returning();
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId: ctx.companyId,
        title: `Crew retrospective — ${String(input.variables?.issueIdentifier)}`,
        identifier: `R-${++issueSeq}`,
        issueNumber: ++issueSeq,
        status: "todo",
        originKind: "routine_execution",
        originId: routineId,
        originRunId: run.id,
      });
      await db.update(routineRuns).set({ linkedIssueId: issueId }).where(eq(routineRuns.id, run.id));
      return { id: run.id, issueId };
    });
  }

  async function decide(ctx: { companyId: string }, issueId: string, outcome: string, actorUserId: string | null = null) {
    await db.insert(issueExecutionDecisions).values({
      companyId: ctx.companyId,
      issueId,
      stageId: randomUUID(),
      stageType: "review",
      actorUserId,
      outcome,
      body: "x",
    });
  }

  async function bounce(ctx: { companyId: string }, issueId: string, runner: ReturnType<typeof makeRunner>, user: string | null = null) {
    await decide(ctx, issueId, "changes_requested", user);
    await maybeTriggerRetro(
      db,
      { companyId: ctx.companyId, issueId, signal: { kind: "decision", outcome: "changes_requested", actorUserId: user } },
      { runRoutine: runner },
    );
  }

  it("fires on the second bounce with the exact variables and idempotency key", async () => {
    const ctx = await seed();
    const runner = makeRunner(ctx);
    await bounce(ctx, ctx.childId, runner);
    expect(runner).not.toHaveBeenCalled();
    await bounce(ctx, ctx.childId, runner);
    expect(runner).toHaveBeenCalledTimes(1);
    const [routineId, input] = runner.mock.calls[0];
    expect(routineId).toBe(ctx.routineId);
    expect(input).toMatchObject({
      source: "api",
      variables: {
        issueIdentifier: ctx.rootIdentifier,
        satisfactionScore: "unscored (auto: bounce_threshold)",
        operatorFeedback: "",
      },
    });
    expect(input.idempotencyKey).toMatch(new RegExp(`^retro:${ctx.rootId}:bounce_threshold:\\d{4}-\\d{2}-\\d{2}$`));
    const rows = await db.select().from(retroTriggers);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rootIssueId: ctx.rootId, signalKind: "bounce_threshold" });
    expect(rows[0].routineRunId).toBeTruthy();
  });

  it("five bounces in one hour trigger exactly one retro per root per cooldown window, none while one is open", async () => {
    const ctx = await seed();
    const runner = makeRunner(ctx);
    for (let i = 0; i < 5; i += 1) await bounce(ctx, i % 2 ? ctx.childId : ctx.rootId, runner);
    expect(await db.select().from(routineRuns)).toHaveLength(1);

    // Cooldown elapsed but the retro issue is still open: still suppressed.
    await db.update(retroTriggers).set({ createdAt: new Date(Date.now() - 25 * 3600_000) });
    await bounce(ctx, ctx.childId, runner);
    expect(await db.select().from(routineRuns)).toHaveLength(1);

    // Retro closed, cooldown elapsed: a new retro may fire.
    await db.update(issues).set({ status: "done" }).where(eq(issues.originKind, "routine_execution"));
    await bounce(ctx, ctx.childId, runner);
    expect(await db.select().from(routineRuns)).toHaveLength(2);

    // Closed but inside the new cooldown: suppressed.
    await db.update(issues).set({ status: "done" }).where(eq(issues.originKind, "routine_execution"));
    await bounce(ctx, ctx.childId, runner);
    expect(await db.select().from(routineRuns)).toHaveLength(2);
  });

  it("sees a manually triggered open retro for the root", async () => {
    const ctx = await seed();
    const runner = makeRunner(ctx);
    await runner(ctx.routineId, { variables: { issueIdentifier: ctx.rootIdentifier, satisfactionScore: "3" } });
    runner.mockClear();
    await bounce(ctx, ctx.childId, runner);
    await bounce(ctx, ctx.childId, runner);
    expect(runner).not.toHaveBeenCalled();
  });

  it("fires immediately on a changes_requested decided by a user", async () => {
    const ctx = await seed();
    const runner = makeRunner(ctx);
    await bounce(ctx, ctx.childId, runner, "user-1");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][1].variables?.satisfactionScore).toBe("unscored (auto: human_changes_requested)");
  });

  it("does not count held or approved decisions as bounces", async () => {
    const ctx = await seed();
    const runner = makeRunner(ctx);
    await decide(ctx, ctx.childId, "held");
    await decide(ctx, ctx.childId, "approved");
    await maybeTriggerRetro(
      db,
      { companyId: ctx.companyId, issueId: ctx.childId, signal: { kind: "decision", outcome: "held", actorUserId: "u" } },
      { runRoutine: runner },
    );
    await maybeTriggerRetro(
      db,
      { companyId: ctx.companyId, issueId: ctx.childId, signal: { kind: "decision", outcome: "approved", actorUserId: "u" } },
      { runRoutine: runner },
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("fires when a run in the tree fails or times out, not when it succeeds", async () => {
    const ctx = await seed();
    const runner = makeRunner(ctx);
    const addRun = async (status: string) =>
      db.insert(heartbeatRuns).values({
        companyId: ctx.companyId,
        agentId: ctx.agentId,
        status,
        contextSnapshot: { issueId: ctx.childId },
      });
    await addRun("succeeded");
    await maybeTriggerRetro(db, { companyId: ctx.companyId, issueId: ctx.childId, signal: { kind: "run_finished", status: "succeeded" } }, { runRoutine: runner });
    expect(runner).not.toHaveBeenCalled();
    await addRun("timed_out");
    await maybeTriggerRetro(db, { companyId: ctx.companyId, issueId: ctx.childId, signal: { kind: "run_finished", status: "timed_out" } }, { runRoutine: runner });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][1].variables?.satisfactionScore).toBe("unscored (auto: run_failed)");
  });

  it("never triggers for a root that a routine created (the retro issue itself, routine issues)", async () => {
    const ctx = await seed();
    const runner = makeRunner(ctx);
    await db.update(issues).set({ originKind: "routine_execution" }).where(eq(issues.id, ctx.rootId));
    await bounce(ctx, ctx.childId, runner, "user-1");
    await bounce(ctx, ctx.childId, runner);
    await bounce(ctx, ctx.childId, runner);
    await db.insert(heartbeatRuns).values({
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      status: "failed",
      contextSnapshot: { issueId: ctx.childId },
    });
    await maybeTriggerRetro(db, { companyId: ctx.companyId, issueId: ctx.childId, signal: { kind: "run_finished", status: "failed" } }, { runRoutine: runner });
    await maybeTriggerRetro(db, { companyId: ctx.companyId, issueId: ctx.rootId, signal: { kind: "cancelled" } }, { runRoutine: runner });
    expect(runner).not.toHaveBeenCalled();
    expect(await db.select().from(retroTriggers)).toHaveLength(0);
  });

  it("does not trigger on a run that failed on a usage limit or an auth failure", async () => {
    const ctx = await seed();
    const runner = makeRunner(ctx);
    const fail = (extra: Record<string, unknown>) =>
      maybeTriggerRetro(
        db,
        { companyId: ctx.companyId, issueId: ctx.childId, signal: { kind: "run_finished", status: "failed", ...extra } },
        { runRoutine: runner },
      );
    await fail({ errorFamily: "usage_limit" });
    await fail({ errorCode: "claude_usage_limit_reached" });
    await fail({ errorCode: "claude_auth_required" });
    await fail({ errorCode: "gemini_auth_required", errorFamily: null });
    expect(runner).not.toHaveBeenCalled();
    await fail({ errorFamily: "model_refusal", errorCode: "adapter_failed" });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][1].variables?.satisfactionScore).toBe("unscored (auto: run_failed)");
  });

  it("counts bounces since the root's latest retro trigger, all-time when there is none", async () => {
    const ctx = await seed();
    const runner = makeRunner(ctx);
    // All-time: two earlier bounces count with no trigger row yet.
    await decide(ctx, ctx.childId, "changes_requested");
    await bounce(ctx, ctx.childId, runner);
    expect(runner).toHaveBeenCalledTimes(1);

    // The retro closes and the cooldown elapses; the bounces it covered are older than its trigger row.
    await db.update(issues).set({ status: "done" }).where(eq(issues.originKind, "routine_execution"));
    await db.update(issueExecutionDecisions).set({ createdAt: new Date(Date.now() - 26 * 3600_000) });
    await db.update(retroTriggers).set({ createdAt: new Date(Date.now() - 25 * 3600_000) });

    // One new bounce since that trigger is below the threshold of 2: no cascade.
    await bounce(ctx, ctx.childId, runner);
    expect(runner).toHaveBeenCalledTimes(1);
    // A second new bounce reaches it again.
    await bounce(ctx, ctx.childId, runner);
    expect(runner).toHaveBeenCalledTimes(2);
    expect((await db.select().from(retroTriggers)).map((r) => r.detail).sort()).toContain("2 bounces (threshold 2)");
  });

  it("fires on cancellation only after work started", async () => {
    const ctx = await seed();
    const runner = makeRunner(ctx);
    await maybeTriggerRetro(db, { companyId: ctx.companyId, issueId: ctx.childId, signal: { kind: "cancelled" } }, { runRoutine: runner });
    expect(runner).not.toHaveBeenCalled();
    await db.insert(heartbeatRuns).values({
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      status: "succeeded",
      contextSnapshot: { issueId: ctx.rootId },
    });
    await maybeTriggerRetro(db, { companyId: ctx.companyId, issueId: ctx.childId, signal: { kind: "cancelled" } }, { runRoutine: runner });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][1].variables?.satisfactionScore).toBe("unscored (auto: cancelled_after_work)");
  });

  it("is a no-op when autoTrigger is false, routineId is null, or there is no blueprint", async () => {
    for (const retro of [{ autoTrigger: false }, { routineId: null }, null]) {
      const ctx = await seed(retro);
      const runner = makeRunner(ctx);
      await bounce(ctx, ctx.childId, runner, "user-1");
      await bounce(ctx, ctx.childId, runner, "user-1");
      expect(runner).not.toHaveBeenCalled();
    }
    expect(await db.select().from(retroTriggers)).toHaveLength(0);
  });

  it("never throws when the routine run fails and releases the cooldown claim", async () => {
    const ctx = await seed();
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      maybeTriggerRetro(
        db,
        { companyId: ctx.companyId, issueId: ctx.childId, signal: { kind: "decision", outcome: "changes_requested", actorUserId: "u" } },
        { runRoutine: failing as never },
      ),
    ).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(await db.select().from(retroTriggers)).toHaveLength(0);
  });

  it("is company scoped: an issue from another company is ignored", async () => {
    const ctx = await seed();
    const other = await seed();
    const runner = makeRunner(ctx);
    await maybeTriggerRetro(
      db,
      { companyId: ctx.companyId, issueId: other.childId, signal: { kind: "decision", outcome: "changes_requested", actorUserId: "u" } },
      { runRoutine: runner },
    );
    expect(runner).not.toHaveBeenCalled();
  });
});
