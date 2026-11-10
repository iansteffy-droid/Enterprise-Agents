import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, pauseIntervals } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dashboardService, getUtcMonthStart } from "../services/dashboard.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dashboard service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function utcDay(offsetDays: number): Date {
  const now = new Date();
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays, 12);
  return new Date(day);
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("getUtcMonthStart", () => {
  it("anchors the monthly spend window to UTC month boundaries", () => {
    expect(getUtcMonthStart(new Date("2026-03-31T20:30:00.000-05:00")).toISOString()).toBe(
      "2026-04-01T00:00:00.000Z",
    );
    expect(getUtcMonthStart(new Date("2026-04-01T00:30:00.000+14:00")).toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });
});

describeEmbeddedPostgres("dashboard service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pauseIntervals);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("aggregates the full 14-day run activity window without recent-run truncation", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const today = utcDay(0);
    const weekAgo = utcDay(-7);

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "OtherAgent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      ...Array.from({ length: 105 }, () => ({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: today,
      })),
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "timed_out",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "cancelled",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        agentId: otherAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: weekAgo,
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.runActivity).toHaveLength(14);
    const todayBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(today));
    const weekAgoBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(weekAgo));

    expect(todayBucket).toMatchObject({
      succeeded: 105,
      failed: 0,
      other: 0,
      total: 105,
    });
    expect(weekAgoBucket).toMatchObject({
      succeeded: 0,
      failed: 2,
      other: 1,
      total: 3,
    });
  });

  it("ranks agents by total finished-run duration in the last 14 days", async () => {
    const companyId = randomUUID();
    const busyAgentId = randomUUID();
    const quietAgentId = randomUUID();
    const today = utcDay(0);
    const outsideWindow = utcDay(-20);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: busyAgentId,
        companyId,
        name: "BusyBee",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: quietAgentId,
        companyId,
        name: "QuietQuokka",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const minutes = (n: number) => new Date(today.getTime() + n * 60_000);

    await db.insert(heartbeatRuns).values([
      // BusyBee: two finished runs totalling 30 minutes.
      {
        id: randomUUID(),
        companyId,
        agentId: busyAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: today,
        startedAt: minutes(0),
        finishedAt: minutes(20),
      },
      {
        id: randomUUID(),
        companyId,
        agentId: busyAgentId,
        invocationSource: "assignment",
        status: "failed",
        createdAt: today,
        startedAt: minutes(30),
        finishedAt: minutes(40),
      },
      // BusyBee: still running (no finishedAt) — must be excluded.
      {
        id: randomUUID(),
        companyId,
        agentId: busyAgentId,
        invocationSource: "assignment",
        status: "running",
        createdAt: today,
        startedAt: minutes(50),
        finishedAt: null,
      },
      // QuietQuokka: one finished run of 5 minutes.
      {
        id: randomUUID(),
        companyId,
        agentId: quietAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: today,
        startedAt: minutes(0),
        finishedAt: minutes(5),
      },
      // QuietQuokka: a long run outside the 14-day window — must be excluded.
      {
        id: randomUUID(),
        companyId,
        agentId: quietAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: outsideWindow,
        startedAt: outsideWindow,
        finishedAt: new Date(outsideWindow.getTime() + 120 * 60_000),
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.agentRunTime).toHaveLength(2);
    expect(summary.agentRunTime[0]).toMatchObject({
      agentId: busyAgentId,
      agentName: "BusyBee",
      totalMs: 30 * 60_000,
      runCount: 2,
    });
    expect(summary.agentRunTime[1]).toMatchObject({
      agentId: quietAgentId,
      agentName: "QuietQuokka",
      totalMs: 5 * 60_000,
      runCount: 1,
    });
  });

  it("clamps crashed/hung runs to their last activity so a far-future finishedAt cannot inflate busy time", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const today = utcDay(0);
    const min = (n: number) => new Date(today.getTime() + n * 60_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Geordi",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values([
      // Normal run: 10 min of real work, activity tracked right up to finish.
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: today,
        startedAt: min(0),
        finishedAt: min(10),
        lastUsefulActionAt: min(9),
        lastOutputAt: min(10),
      },
      // Crashed run: process_lost. finishedAt stamped ~64h after the crash, but the
      // last real activity was at min(2). Must contribute ~2 min, not 64h.
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        errorCode: "process_lost",
        createdAt: today,
        startedAt: min(0),
        finishedAt: min(64 * 60),
        lastUsefulActionAt: min(1),
        lastOutputAt: min(2),
      },
      // Hung idle run: succeeded but flagged needs_followup. Ran ~14h wall-clock, but
      // last output was at min(3) and it produced no useful action after. Clamp to min(3).
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        livenessState: "needs_followup",
        createdAt: today,
        startedAt: min(0),
        finishedAt: min(14 * 60),
        lastUsefulActionAt: null,
        lastOutputAt: min(3),
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    // 10 (normal) + 2 (crash, clamped to lastOutputAt) + 3 (hung, clamped to lastOutputAt).
    expect(summary.agentRunTime).toHaveLength(1);
    expect(summary.agentRunTime[0]).toMatchObject({
      agentId,
      totalMs: 15 * 60_000,
      runCount: 3,
    });

    const engineer = summary.roleFlow.find((row) => row.role === "engineer");
    expect(engineer?.busyMs).toBe(15 * 60_000);
  });

  it("summarizes role flow: a busy, backlogged, falling-behind role is a bottleneck", async () => {
    const companyId = randomUUID();
    const geordiId = randomUUID();
    const deannaId = randomUUID();
    const base = utcDay(0);
    const min = (n: number) => new Date(base.getTime() + n * 60_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: geordiId,
        companyId,
        name: "Geordi",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: deannaId,
        companyId,
        name: "Deanna",
        role: "designer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    // Busy time: Geordi 30 min across two finished runs, Deanna 5 min.
    await db.insert(heartbeatRuns).values([
      {
        id: randomUUID(),
        companyId,
        agentId: geordiId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: base,
        startedAt: min(0),
        finishedAt: min(20),
      },
      {
        id: randomUUID(),
        companyId,
        agentId: geordiId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: base,
        startedAt: min(30),
        finishedAt: min(40),
      },
      {
        id: randomUUID(),
        companyId,
        agentId: deannaId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: base,
        startedAt: min(0),
        finishedAt: min(5),
      },
    ]);

    await db.insert(issues).values([
      // Geordi (engineer): waits of 10/20/30 min; 2 done, 1 in progress.
      { companyId, title: "E-A", assigneeAgentId: geordiId, status: "done", createdAt: base, startedAt: min(10), completedAt: min(15) },
      { companyId, title: "E-B", assigneeAgentId: geordiId, status: "in_progress", createdAt: base, startedAt: min(30) },
      { companyId, title: "E-C", assigneeAgentId: geordiId, status: "done", createdAt: base, startedAt: min(20), completedAt: min(25) },
      // Geordi: two unstarted issues in the queue.
      { companyId, title: "E-D", assigneeAgentId: geordiId, status: "todo", createdAt: base },
      { companyId, title: "E-E", assigneeAgentId: geordiId, status: "backlog", createdAt: base },
      // Geordi: a cancelled issue must not count toward queue or arrivals.
      { companyId, title: "E-X", assigneeAgentId: geordiId, status: "cancelled", createdAt: base, cancelledAt: min(1) },
      // Deanna (designer): keeps up — everything created is completed, nothing queued.
      { companyId, title: "D-F", assigneeAgentId: deannaId, status: "done", createdAt: base, startedAt: min(2), completedAt: min(4) },
      { companyId, title: "D-G", assigneeAgentId: deannaId, status: "done", createdAt: base, startedAt: min(3), completedAt: min(5) },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    const engineer = summary.roleFlow.find((row) => row.role === "engineer");
    const designer = summary.roleFlow.find((row) => row.role === "designer");

    expect(engineer).toMatchObject({
      role: "engineer",
      busyMs: 30 * 60_000,
      queueDepth: 2,
      waitP50Ms: 20 * 60_000,
      waitP90Ms: 28 * 60_000,
      createdCount: 5,
      completedCount: 2,
      classification: "bottleneck",
    });
    expect(engineer?.flowRatio).toBeCloseTo(0.4, 5);
    expect(engineer?.agents).toHaveLength(1);
    expect(engineer?.agents[0]).toMatchObject({
      agentId: geordiId,
      agentName: "Geordi",
      busyMs: 30 * 60_000,
      queueDepth: 2,
      waitP50Ms: 20 * 60_000,
      waitP90Ms: 28 * 60_000,
    });

    expect(designer).toMatchObject({
      role: "designer",
      busyMs: 5 * 60_000,
      queueDepth: 0,
      createdCount: 2,
      completedCount: 2,
      classification: "keeping_up",
    });
    expect(designer?.flowRatio).toBeCloseTo(1, 5);
  });

  it("subtracts paused time from role-flow wait", async () => {
    const companyId = randomUUID();
    const geordiId = randomUUID();
    const base = utcDay(0);
    const min = (n: number) => new Date(base.getTime() + n * 60_000);

    await db.insert(companies).values({
      id: companyId, name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: geordiId, companyId, name: "Geordi", role: "engineer", status: "running",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    // Raw wait = 30 min (created at min(0), started at min(30)).
    await db.insert(issues).values({
      companyId, title: "E-A", assigneeAgentId: geordiId, status: "done",
      createdAt: min(0), startedAt: min(30), completedAt: min(35),
    });
    // Agent paused min(5)..min(15) => 10 min of the wait window is paused.
    await db.insert(pauseIntervals).values({
      companyId, scopeType: "agent", scopeId: geordiId, reason: "manual",
      startedAt: min(5), endedAt: min(15),
    });

    const summary = await dashboardService(db).summary(companyId);
    const engineer = summary.roleFlow.find((r) => r.role === "engineer");
    expect(engineer?.waitP50Ms).toBe(20 * 60_000); // 30 - 10
  });
});
