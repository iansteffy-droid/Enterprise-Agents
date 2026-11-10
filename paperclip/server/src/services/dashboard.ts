import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRuns, issues, pauseIntervals } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";
import { classifyRole, roleFlowThresholds } from "./dashboard-classify.js";
import { pausedOverlapMs, percentileCont } from "./wait-time.js";

const DASHBOARD_RUN_ACTIVITY_DAYS = 14;
const DASHBOARD_AGENT_RUN_TIME_LIMIT = 15;

function formatUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getUtcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getRecentUtcDateKeys(now: Date, days: number): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const dayOffset = index - (days - 1);
    return formatUtcDateKey(new Date(todayUtc + dayOffset * 24 * 60 * 60 * 1000));
  });
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  return {
    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(eq(issues.companyId, companyId))
        .groupBy(issues.status);

      const pendingApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .then((rows) => Number(rows[0]?.count ?? 0));

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" agents are operational — count them as active
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const now = new Date();
      const monthStart = getUtcMonthStart(now);
      const runActivityDays = getRecentUtcDateKeys(now, DASHBOARD_RUN_ACTIVITY_DAYS);
      const runActivityStart = new Date(`${runActivityDays[0]}T00:00:00.000Z`);
      const [{ monthSpend }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
          ),
        );

      const monthSpendCents = Number(monthSpend);
      const runActivityDayExpr = sql<string>`to_char(${heartbeatRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const runActivityRows = await db
        .select({
          date: runActivityDayExpr,
          status: heartbeatRuns.status,
          count: sql<number>`count(*)::double precision`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, runActivityStart),
          ),
        )
        .groupBy(runActivityDayExpr, heartbeatRuns.status);

      const runActivity = new Map(
        runActivityDays.map((date) => [
          date,
          { date, succeeded: 0, failed: 0, other: 0, total: 0 },
        ]),
      );
      for (const row of runActivityRows) {
        const bucket = runActivity.get(row.date);
        if (!bucket) continue;
        const count = Number(row.count);
        if (row.status === "succeeded") bucket.succeeded += count;
        else if (row.status === "failed" || row.status === "timed_out") bucket.failed += count;
        else bucket.other += count;
        bucket.total += count;
      }

      // Top agents by total finished-run duration within the run-activity window.
      //
      // Busy time is clamped to the last evidence of real work rather than the raw
      // finishedAt span: the watchdog stamps finishedAt long after a crashed
      // (process_lost) or hung run actually stopped doing anything, which would
      // otherwise bank the full wall-clock gap. We bound the "busy
      // until" moment to greatest(lastUsefulActionAt, lastOutputAt) — the later of
      // the two activity markers — capped at finishedAt so a normal run (whose
      // activity runs right up to finish) is unaffected, and floored at 0 to guard
      // against clock skew. GREATEST/LEAST ignore NULLs in Postgres, so a run with
      // no activity markers at all falls back to its finishedAt span.
      const runBusyEndExpr = sql`least(${heartbeatRuns.finishedAt}, greatest(${heartbeatRuns.lastUsefulActionAt}, ${heartbeatRuns.lastOutputAt}))`;
      const runDurationMsExpr = sql<number>`coalesce(sum(greatest(extract(epoch from (${runBusyEndExpr} - ${heartbeatRuns.startedAt})) * 1000, 0)), 0)::double precision`;
      const agentRunTimeRows = await db
        .select({
          agentId: heartbeatRuns.agentId,
          agentName: agents.name,
          agentStatus: agents.status,
          totalMs: runDurationMsExpr,
          runCount: sql<number>`count(*)::double precision`,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.startedAt, runActivityStart),
            isNotNull(heartbeatRuns.startedAt),
            isNotNull(heartbeatRuns.finishedAt),
          ),
        )
        .groupBy(heartbeatRuns.agentId, agents.name, agents.status)
        .orderBy(desc(runDurationMsExpr))
        .limit(DASHBOARD_AGENT_RUN_TIME_LIMIT);

      const agentRunTime = agentRunTimeRows.map((row) => ({
        agentId: row.agentId,
        agentName: row.agentName,
        agentStatus: row.agentStatus,
        totalMs: Number(row.totalMs),
        runCount: Number(row.runCount),
      }));

      // Role flow: pair busy time with the queue forming in front of each role
      // so "who worked most" becomes "is this role a bottleneck". Wait time is a
      // proxy (createdAt -> startedAt) because we have no status-transition
      // history; queue depth is a live snapshot; flow ratio is windowed.
      const windowStartIso = runActivityStart.toISOString();
      const windowStartTs = sql`${windowStartIso}::timestamptz`;
      const createdCountExpr = sql<number>`count(*) filter (where ${issues.createdAt} >= ${windowStartTs} and ${issues.status} <> 'cancelled')::double precision`;
      const completedCountExpr = sql<number>`count(*) filter (where ${issues.completedAt} is not null and ${issues.completedAt} >= ${windowStartTs})::double precision`;
      const queueDepthExpr = sql<number>`count(*) filter (where ${issues.startedAt} is null and ${issues.status} not in ('done', 'cancelled'))::double precision`;

      const roleAggRows = await db
        .select({
          role: agents.role,
          createdCount: createdCountExpr,
          completedCount: completedCountExpr,
          queueDepth: queueDepthExpr,
        })
        .from(issues)
        .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
        .where(eq(issues.companyId, companyId))
        .groupBy(agents.role);

      const agentAggRows = await db
        .select({
          agentId: issues.assigneeAgentId,
          agentName: agents.name,
          agentStatus: agents.status,
          role: agents.role,
          queueDepth: queueDepthExpr,
        })
        .from(issues)
        .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
        .where(eq(issues.companyId, companyId))
        .groupBy(issues.assigneeAgentId, agents.name, agents.status, agents.role);

      // Busy time per agent, untruncated (agentRunTime above is capped at the
      // top N for its own display; role totals need every agent).
      const agentBusyRows = await db
        .select({
          agentId: heartbeatRuns.agentId,
          agentName: agents.name,
          agentStatus: agents.status,
          role: agents.role,
          busyMs: runDurationMsExpr,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.startedAt, runActivityStart),
            isNotNull(heartbeatRuns.startedAt),
            isNotNull(heartbeatRuns.finishedAt),
          ),
        )
        .groupBy(heartbeatRuns.agentId, agents.name, agents.status, agents.role);

      type RoleFlowAgent = {
        agentId: string;
        agentName: string;
        agentStatus: string;
        role: string;
        busyMs: number;
        queueDepth: number;
        waitP50Ms: number | null;
        waitP90Ms: number | null;
      };

      const flowAgents = new Map<string, RoleFlowAgent>();
      const ensureAgent = (row: {
        agentId: string | null;
        agentName: string;
        agentStatus: string;
        role: string;
      }): RoleFlowAgent | null => {
        if (!row.agentId) return null;
        let agent = flowAgents.get(row.agentId);
        if (!agent) {
          agent = {
            agentId: row.agentId,
            agentName: row.agentName,
            agentStatus: row.agentStatus,
            role: row.role,
            busyMs: 0,
            queueDepth: 0,
            waitP50Ms: null,
            waitP90Ms: null,
          };
          flowAgents.set(row.agentId, agent);
        }
        return agent;
      };

      for (const row of agentBusyRows) {
        const agent = ensureAgent(row);
        if (agent) agent.busyMs = Number(row.busyMs);
      }
      for (const row of agentAggRows) {
        const agent = ensureAgent(row);
        if (!agent) continue;
        agent.queueDepth = Number(row.queueDepth);
      }

      // Started issues in-window with the fields needed to adjust wait.
      const startedIssueRows = await db
        .select({
          agentId: issues.assigneeAgentId,
          role: agents.role,
          projectId: issues.projectId,
          createdAt: issues.createdAt,
          startedAt: issues.startedAt,
        })
        .from(issues)
        .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
        .where(
          and(
            eq(issues.companyId, companyId),
            isNotNull(issues.startedAt),
            gte(issues.startedAt, runActivityStart),
          ),
        );

      // All pause intervals for the company that could overlap any wait window.
      const pauseRows = await db
        .select({
          scopeType: pauseIntervals.scopeType,
          scopeId: pauseIntervals.scopeId,
          startedAt: pauseIntervals.startedAt,
          endedAt: pauseIntervals.endedAt,
        })
        .from(pauseIntervals)
        .where(eq(pauseIntervals.companyId, companyId));

      const byAgent = new Map<string, typeof pauseRows>();
      const byProject = new Map<string, typeof pauseRows>();
      const companyPauses: typeof pauseRows = [];
      for (const row of pauseRows) {
        if (row.scopeType === "agent") {
          const list = byAgent.get(row.scopeId) ?? [];
          list.push(row); byAgent.set(row.scopeId, list);
        } else if (row.scopeType === "project") {
          const list = byProject.get(row.scopeId) ?? [];
          list.push(row); byProject.set(row.scopeId, list);
        } else if (row.scopeType === "company") {
          companyPauses.push(row);
        }
      }

      const computeNow = new Date();
      // Adjusted per-issue waits, bucketed by role and by agent.
      const waitsByRole = new Map<string, number[]>();
      const waitsByAgent = new Map<string, number[]>();
      for (const issue of startedIssueRows) {
        if (!issue.startedAt || !issue.agentId) continue;
        const raw = issue.startedAt.getTime() - issue.createdAt.getTime();
        const relevant = [
          ...(byAgent.get(issue.agentId) ?? []),
          ...(issue.projectId ? byProject.get(issue.projectId) ?? [] : []),
          ...companyPauses,
        ];
        const paused = pausedOverlapMs(issue.createdAt, issue.startedAt, relevant, computeNow);
        const adjusted = Math.max(0, raw - paused);
        const roleList = waitsByRole.get(issue.role) ?? [];
        roleList.push(adjusted); waitsByRole.set(issue.role, roleList);
        const agentList = waitsByAgent.get(issue.agentId) ?? [];
        agentList.push(adjusted); waitsByAgent.set(issue.agentId, agentList);
      }

      // Set per-agent wait percentiles from JS-computed pause-adjusted buckets.
      for (const agent of flowAgents.values()) {
        agent.waitP50Ms = percentileCont(waitsByAgent.get(agent.agentId) ?? [], 0.5);
        agent.waitP90Ms = percentileCont(waitsByAgent.get(agent.agentId) ?? [], 0.9);
      }

      const roleAggByRole = new Map(roleAggRows.map((row) => [row.role, row]));
      const roleNames = new Set<string>([
        ...roleAggRows.map((row) => row.role),
        ...Array.from(flowAgents.values(), (agent) => agent.role),
      ]);

      const roleFlowDraft = Array.from(roleNames, (role) => {
        const agg = roleAggByRole.get(role);
        const agentsForRole = Array.from(flowAgents.values())
          .filter((agent) => agent.role === role)
          .sort((a, b) => b.busyMs - a.busyMs);
        const busyMs = agentsForRole.reduce((sum, agent) => sum + agent.busyMs, 0);
        const createdCount = agg ? Number(agg.createdCount) : 0;
        const completedCount = agg ? Number(agg.completedCount) : 0;
        return {
          role,
          busyMs,
          queueDepth: agg ? Number(agg.queueDepth) : 0,
          waitP50Ms: percentileCont(waitsByRole.get(role) ?? [], 0.5),
          waitP90Ms: percentileCont(waitsByRole.get(role) ?? [], 0.9),
          createdCount,
          completedCount,
          flowRatio: createdCount > 0 ? completedCount / createdCount : null,
          agents: agentsForRole.map((agent) => ({
            agentId: agent.agentId,
            agentName: agent.agentName,
            agentStatus: agent.agentStatus,
            busyMs: agent.busyMs,
            queueDepth: agent.queueDepth,
            waitP50Ms: agent.waitP50Ms,
            waitP90Ms: agent.waitP90Ms,
          })),
        };
      });

      const thresholds = roleFlowThresholds(
        roleFlowDraft.map((row) => ({ busyMs: row.busyMs, waitP90Ms: row.waitP90Ms })),
      );
      const roleFlow = roleFlowDraft
        .map((row) => ({
          ...row,
          classification: classifyRole(
            {
              busyMs: row.busyMs,
              queueDepth: row.queueDepth,
              waitP90Ms: row.waitP90Ms,
              flowRatio: row.flowRatio,
            },
            thresholds,
          ),
        }))
        .sort((a, b) => b.busyMs - a.busyMs);

      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId);

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
        },
        pendingApprovals,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        runActivity: Array.from(runActivity.values()),
        agentRunTime,
        roleFlow,
      };
    },
  };
}
