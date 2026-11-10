import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  costEvents,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import type { RetroAgentMetrics, RetroMetrics } from "@paperclipai/shared";

/** The one definition of a bounce: a decision row with this outcome. `held` is never a bounce. */
export const BOUNCE_OUTCOME = "changes_requested";
const APPROVED_OUTCOME = "approved";
const FINDING_MARKER = /\b(blocker|major|minor|nitpick)\b/i;
const MISSING_COMMENT_WAKE_REASON = "missing_issue_comment";
const ENDED_RUN_STATUSES = new Set(["succeeded", "failed", "timed_out", "cancelled"]);

function emptyAgent(agentId: string, agentName: string): RetroAgentMetrics {
  return {
    agentId,
    agentName,
    runs: 0,
    failedRuns: 0,
    timedOutRuns: 0,
    cancelledRuns: 0,
    costCents: 0,
    decisions: 0,
    changesRequestedIssued: 0,
    approvalsWithFindings: 0,
    changesRequestedReceived: 0,
    wastedWakes: 0,
    wakeReasons: {},
  };
}

/** The visible ticket tree under a root (root included); hidden issues are excluded. */
export async function ticketTreeIssueIds(db: Db, companyId: string, rootIssueId: string): Promise<string[]> {
  const treeRows = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE tree(id) AS (
      SELECT ${issues.id} FROM ${issues}
      WHERE ${issues.id} = ${rootIssueId} AND ${issues.companyId} = ${companyId} AND ${issues.hiddenAt} IS NULL
      UNION
      SELECT child.id FROM ${issues} child
      JOIN tree ON child.parent_id = tree.id
      WHERE child.company_id = ${companyId} AND child.hidden_at IS NULL
    )
    SELECT id FROM tree
  `);
  return (Array.isArray(treeRows) ? treeRows : (treeRows as { rows: { id: string }[] }).rows).map((row) => row.id);
}

/** Per-ticket-tree retro metrics (read only). Null when the root is missing or in another company. */
export async function computeRetroMetrics(
  db: Db,
  companyId: string,
  rootIssueId: string,
): Promise<RetroMetrics | null> {
  const root = await db
    .select({ id: issues.id, identifier: issues.identifier, completedAt: issues.completedAt })
    .from(issues)
    .where(and(eq(issues.id, rootIssueId), eq(issues.companyId, companyId), isNull(issues.hiddenAt)))
    .then((rows) => rows[0] ?? null);
  if (!root) return null;

  const issueIds = await ticketTreeIssueIds(db, companyId, rootIssueId);

  const issueIdentifiers = new Map<string, string>();
  const executionStates = new Map<string, Record<string, unknown> | null>();
  for (const row of await db
    .select({ id: issues.id, identifier: issues.identifier, executionState: issues.executionState })
    .from(issues)
    .where(inArray(issues.id, issueIds))) {
    issueIdentifiers.set(row.id, row.identifier ?? row.id);
    executionStates.set(row.id, row.executionState);
  }

  const runIssueId = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
  const runs = await db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
      issueId: runIssueId,
      wakeReason: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeReason'`,
    })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), inArray(runIssueId, issueIds)))
    .orderBy(asc(heartbeatRuns.createdAt));
  const runIds = runs.map((run) => run.id);

  const decisions = await db
    .select()
    .from(issueExecutionDecisions)
    .where(and(eq(issueExecutionDecisions.companyId, companyId), inArray(issueExecutionDecisions.issueId, issueIds)))
    .orderBy(asc(issueExecutionDecisions.createdAt));

  const costs = await db
    .select({ id: costEvents.id, agentId: costEvents.agentId, costCents: costEvents.costCents })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        or(
          inArray(costEvents.issueId, issueIds),
          runIds.length > 0 ? inArray(costEvents.heartbeatRunId, runIds) : undefined,
        ),
      ),
    );

  const recoveryActionCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issueRecoveryActions)
    .where(
      and(eq(issueRecoveryActions.companyId, companyId), inArray(issueRecoveryActions.sourceIssueId, issueIds)),
    )
    .then((rows) => rows[0]?.count ?? 0);

  // Runs that produced something: a decision, a comment or an issue status change.
  const productiveRunIds = new Set<string>();
  for (const decision of decisions) if (decision.createdByRunId) productiveRunIds.add(decision.createdByRunId);
  if (runIds.length > 0) {
    const commentRuns = await db
      .select({ runId: issueComments.createdByRunId })
      .from(issueComments)
      .where(and(eq(issueComments.companyId, companyId), inArray(issueComments.createdByRunId, runIds)));
    for (const row of commentRuns) if (row.runId) productiveRunIds.add(row.runId);

    const statusChangeRuns = await db
      .select({ runId: activityLog.runId })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          inArray(activityLog.entityId, issueIds),
          inArray(activityLog.runId, runIds),
          sql`${activityLog.details} -> '_previous' ->> 'status' IS NOT NULL`,
          sql`${activityLog.details} ->> 'status' IS DISTINCT FROM ${activityLog.details} -> '_previous' ->> 'status'`,
        ),
      );
    for (const row of statusChangeRuns) if (row.runId) productiveRunIds.add(row.runId);
  }

  const agentIds = new Set<string>([
    ...runs.map((run) => run.agentId),
    ...costs.map((cost) => cost.agentId),
    ...decisions.flatMap((decision) => (decision.actorAgentId ? [decision.actorAgentId] : [])),
  ]);
  const names = new Map<string, string>();
  if (agentIds.size > 0) {
    for (const row of await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, [...agentIds]))) {
      names.set(row.id, row.name);
    }
  }
  const perAgent = new Map<string, RetroAgentMetrics>();
  const agentMetrics = (agentId: string) => {
    let entry = perAgent.get(agentId);
    if (!entry) {
      entry = emptyAgent(agentId, names.get(agentId) ?? agentId);
      perAgent.set(agentId, entry);
    }
    return entry;
  };

  let wastedWakes = 0;
  let cancelledRuns = 0;
  let missingCommentRetries = 0;
  let firstRunAt: Date | null = null;
  for (const run of runs) {
    const metrics = agentMetrics(run.agentId);
    metrics.runs += 1;
    if (run.status === "failed") metrics.failedRuns += 1;
    if (run.status === "timed_out") metrics.timedOutRuns += 1;
    if (run.status === "cancelled") {
      metrics.cancelledRuns += 1;
      cancelledRuns += 1;
    }
    const reason = run.wakeReason ?? "unknown";
    metrics.wakeReasons[reason] = (metrics.wakeReasons[reason] ?? 0) + 1;
    if (run.wakeReason === MISSING_COMMENT_WAKE_REASON) missingCommentRetries += 1;
    if (ENDED_RUN_STATUSES.has(run.status) && !productiveRunIds.has(run.id)) {
      metrics.wastedWakes += 1;
      wastedWakes += 1;
    }
    const startedAt = run.startedAt ?? run.createdAt;
    if (!firstRunAt || startedAt < firstRunAt) firstRunAt = startedAt;
  }

  let costCents = 0;
  for (const cost of costs) {
    agentMetrics(cost.agentId).costCents += cost.costCents;
    costCents += cost.costCents;
  }

  const bounceTimeline: RetroMetrics["bounceTimeline"] = [];
  let bounces = 0;
  for (const decision of decisions) {
    if (decision.actorAgentId) {
      const metrics = agentMetrics(decision.actorAgentId);
      metrics.decisions += 1;
      if (decision.outcome === BOUNCE_OUTCOME) metrics.changesRequestedIssued += 1;
      if (decision.outcome === APPROVED_OUTCOME && FINDING_MARKER.test(decision.body)) {
        metrics.approvalsWithFindings += 1;
      }
    }
    if (decision.outcome !== BOUNCE_OUTCOME) continue;
    bounces += 1;
    // The bounce lands on the author: the issue's return assignee when the execution state
    // still records this decision as the last one, else the latest succeeded run on the issue by
    // an agent other than the deciding reviewer. Runs are in creation order; ties keep the earlier.
    let culprit: string | null = null;
    const state = executionStates.get(decision.issueId);
    const returnAssignee = state?.returnAssignee as { type?: string; agentId?: string | null } | null | undefined;
    if (state?.lastDecisionId === decision.id && returnAssignee?.type === "agent" && returnAssignee.agentId) {
      culprit = returnAssignee.agentId;
    } else {
      let culpritAt = -Infinity;
      for (const run of runs) {
        if (run.issueId !== decision.issueId || run.status !== "succeeded") continue;
        if (decision.actorAgentId && run.agentId === decision.actorAgentId) continue;
        const endedAt = (run.finishedAt ?? run.createdAt).getTime();
        if (endedAt <= decision.createdAt.getTime() && endedAt > culpritAt) {
          culprit = run.agentId;
          culpritAt = endedAt;
        }
      }
    }
    if (culprit) agentMetrics(culprit).changesRequestedReceived += 1;
    bounceTimeline.push({
      issueIdentifier: issueIdentifiers.get(decision.issueId) ?? decision.issueId,
      stageType: decision.stageType,
      actorName: decision.actorAgentId
        ? (names.get(decision.actorAgentId) ?? decision.actorAgentId)
        : (decision.actorUserId ?? "unknown"),
      outcome: decision.outcome,
      createdAt: decision.createdAt.toISOString(),
    });
  }

  return {
    rootIssueId: root.id,
    rootIdentifier: root.identifier ?? root.id,
    issueIds,
    firstRunAt: firstRunAt ? (firstRunAt as Date).toISOString() : null,
    doneAt: root.completedAt ? root.completedAt.toISOString() : null,
    totals: {
      runs: runs.length,
      costCents,
      decisions: decisions.length,
      bounces,
      cancelledRuns,
      wastedWakes,
      recoveryActions: recoveryActionCount,
      missingCommentRetries,
    },
    agents: [...perAgent.values()].sort((x, y) => x.agentName.localeCompare(y.agentName)),
    bounceTimeline,
  };
}
