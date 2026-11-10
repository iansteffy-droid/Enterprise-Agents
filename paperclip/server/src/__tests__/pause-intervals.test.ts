import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, pauseIntervals } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { openPauseInterval, closePauseInterval } from "../services/pause-intervals.ts";
import { agentService } from "../services/agents.ts";
import { companyService } from "../services/companies.ts";
import { budgetService } from "../services/budgets.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("pause intervals service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pause-intervals-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pauseIntervals);
    await db.delete(agents);
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const makeCompany = async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  };

  it("opens an interval, closes it on resume, and is idempotent on double-open", async () => {
    const companyId = await makeCompany();
    const scopeId = randomUUID();
    const start = new Date("2026-07-01T00:00:00.000Z");
    const end = new Date("2026-07-01T01:00:00.000Z");

    await openPauseInterval(db, { companyId, scopeType: "agent", scopeId, reason: "manual", at: start });
    // Double-open must not stack a second open row.
    await openPauseInterval(db, { companyId, scopeType: "agent", scopeId, reason: "manual", at: start });

    const openRows = await db
      .select()
      .from(pauseIntervals)
      .where(and(eq(pauseIntervals.scopeId, scopeId), isNull(pauseIntervals.endedAt)));
    expect(openRows).toHaveLength(1);

    await closePauseInterval(db, { scopeType: "agent", scopeId, at: end });

    const all = await db.select().from(pauseIntervals).where(eq(pauseIntervals.scopeId, scopeId));
    expect(all).toHaveLength(1);
    expect(all[0].endedAt?.toISOString()).toBe(end.toISOString());
  });

  it("close is a no-op when nothing is open", async () => {
    const scopeId = randomUUID();
    await closePauseInterval(db, { scopeType: "agent", scopeId, at: new Date() });
    const all = await db.select().from(pauseIntervals).where(eq(pauseIntervals.scopeId, scopeId));
    expect(all).toHaveLength(0);
  });

  it("agentService.pause opens an interval and resume closes it", async () => {
    const companyId = await makeCompany();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "Geordi", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });

    const svc = agentService(db);
    await svc.pause(agentId); // reason defaults to "manual"

    let openRows = await db
      .select().from(pauseIntervals)
      .where(and(eq(pauseIntervals.scopeId, agentId), isNull(pauseIntervals.endedAt)));
    expect(openRows).toHaveLength(1);
    expect(openRows[0].reason).toBe("manual");
    expect(openRows[0].scopeType).toBe("agent");

    await svc.resume(agentId);
    openRows = await db
      .select().from(pauseIntervals)
      .where(and(eq(pauseIntervals.scopeId, agentId), isNull(pauseIntervals.endedAt)));
    expect(openRows).toHaveLength(0);
  });

  it("company archive opens company_archived intervals; reactivation closes them", async () => {
    const companyId = await makeCompany();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "Geordi", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const companies_svc = companyService(db);

    await companies_svc.archive(companyId, { actorType: "user", actorId: "u1" });
    let open = await db.select().from(pauseIntervals)
      .where(and(eq(pauseIntervals.scopeId, agentId), isNull(pauseIntervals.endedAt)));
    expect(open).toHaveLength(1);
    expect(open[0].reason).toBe("company_archived");

    await companies_svc.update(companyId, { status: "active" }, { actorType: "user", actorId: "u1" });
    open = await db.select().from(pauseIntervals)
      .where(and(eq(pauseIntervals.scopeId, agentId), isNull(pauseIntervals.endedAt)));
    expect(open).toHaveLength(0);
  });

  it("budget pause opens a 'budget' interval and budget resume closes it", async () => {
    const companyId = await makeCompany();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "Geordi", role: "engineer", status: "running",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const svc = budgetService(db);
    const policy = {
      id: randomUUID(),
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;

    await svc.pauseScopeForBudget(policy);
    let open = await db.select().from(pauseIntervals)
      .where(and(eq(pauseIntervals.scopeId, agentId), isNull(pauseIntervals.endedAt)));
    expect(open).toHaveLength(1);
    expect(open[0].reason).toBe("budget");
    expect(open[0].scopeType).toBe("agent");

    await svc.resumeScopeFromBudget(policy);
    open = await db.select().from(pauseIntervals)
      .where(and(eq(pauseIntervals.scopeId, agentId), isNull(pauseIntervals.endedAt)));
    expect(open).toHaveLength(0);
  });
});
