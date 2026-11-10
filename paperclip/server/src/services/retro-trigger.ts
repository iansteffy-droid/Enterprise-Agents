import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueExecutionDecisions, issues, retroTriggers, workflowBlueprints } from "@paperclipai/db";
import type { RunRoutine } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { BOUNCE_OUTCOME, ticketTreeIssueIds } from "./retro-metrics.js";

export type RetroSignalKind = "bounce_threshold" | "human_changes_requested" | "run_failed" | "cancelled_after_work";

/** The event that happened on an issue; maybeTriggerRetro decides which retro signal (if any) it amounts to. */
export type RetroEvent =
  | { kind: "decision"; outcome: string; actorUserId: string | null }
  | { kind: "run_finished"; status: string; errorFamily?: string | null; errorCode?: string | null }
  | { kind: "cancelled" };

export interface RetroTriggerDeps {
  runRoutine?: (routineId: string, input: RunRoutine) => Promise<{ id: string }>;
}

const DEFAULT_BOUNCE_THRESHOLD = 2;
const DEFAULT_COOLDOWN_HOURS = 24;
const CLOSED_STATUSES = ["done", "cancelled"];
const MAX_PARENT_DEPTH = 100;
/** Adapter error families (heartbeat retry logic) that mean the infrastructure failed, not the crew. */
const INFRA_ERROR_FAMILIES = new Set(["usage_limit"]);
const USAGE_LIMIT_ERROR_CODES = new Set(["claude_usage_limit_reached"]);
/** Roots a routine created (a retro issue itself, routine runs) never start a retro. */
const ROUTINE_ORIGIN_KIND = "routine_execution";

/** A run that failed on a usage limit or an auth failure says nothing about how the crew worked. */
export function isInfraRunFailure(input: { errorFamily?: string | null; errorCode?: string | null }): boolean {
  if (input.errorFamily && INFRA_ERROR_FAMILIES.has(input.errorFamily)) return true;
  const code = input.errorCode ?? "";
  return USAGE_LIMIT_ERROR_CODES.has(code) || code.endsWith("_auth_required");
}

async function defaultRunRoutine(db: Db, routineId: string, input: RunRoutine) {
  // Lazy: routines.ts imports heartbeat.ts, which calls this service.
  const { routineService } = await import("./routines.js");
  return routineService(db).runRoutine(routineId, input);
}

async function resolveRoot(db: Db, companyId: string, issueId: string) {
  let currentId: string | null = issueId;
  let root: { id: string; identifier: string | null; originKind: string | null } | null = null;
  for (let depth = 0; currentId && depth < MAX_PARENT_DEPTH; depth += 1) {
    const row: { id: string; identifier: string | null; parentId: string | null; originKind: string | null } | undefined = await db
      .select({ id: issues.id, identifier: issues.identifier, parentId: issues.parentId, originKind: issues.originKind })
      .from(issues)
      .where(and(eq(issues.id, currentId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0]);
    if (!row) return null;
    root = row;
    currentId = row.parentId;
  }
  return root;
}

async function evaluateSignal(
  db: Db,
  companyId: string,
  rootId: string,
  treeIds: string[],
  event: RetroEvent,
  bounceThreshold: number,
): Promise<{ kind: RetroSignalKind; detail: string } | null> {
  if (event.kind === "decision") {
    if (event.outcome !== BOUNCE_OUTCOME) return null;
    if (event.actorUserId) return { kind: "human_changes_requested", detail: "changes requested by a user" };
    // Bounces a previous retro already covered do not count again: only those since the root's latest trigger.
    const latestTrigger = await db
      .select({ createdAt: retroTriggers.createdAt })
      .from(retroTriggers)
      .where(and(eq(retroTriggers.companyId, companyId), eq(retroTriggers.rootIssueId, rootId)))
      .orderBy(desc(retroTriggers.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.createdAt ?? null);
    const bounces = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(issueExecutionDecisions)
      .where(
        and(
          eq(issueExecutionDecisions.companyId, companyId),
          eq(issueExecutionDecisions.outcome, BOUNCE_OUTCOME),
          inArray(issueExecutionDecisions.issueId, treeIds),
          latestTrigger ? gt(issueExecutionDecisions.createdAt, latestTrigger) : undefined,
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
    return bounces >= bounceThreshold
      ? { kind: "bounce_threshold", detail: `${bounces} bounces (threshold ${bounceThreshold})` }
      : null;
  }
  if (event.kind === "run_finished") {
    if (event.status !== "failed" && event.status !== "timed_out") return null;
    if (isInfraRunFailure(event)) return null;
    return { kind: "run_failed", detail: `a run ended ${event.status}` };
  }
  const runIssueId = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
  const succeeded = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.status, "succeeded"),
        inArray(runIssueId, treeIds),
      ),
    )
    .then((rows) => rows[0]?.count ?? 0);
  return succeeded > 0 ? { kind: "cancelled_after_work", detail: "cancelled after work started" } : null;
}

/**
 * Starts the blueprint's retro routine when an issue event amounts to a retro signal for its top-level
 * root. Checks config, cooldown and open retros itself; callers make one call and never see errors.
 */
export async function maybeTriggerRetro(
  db: Db,
  input: { companyId: string; issueId: string; signal: RetroEvent },
  deps: RetroTriggerDeps = {},
): Promise<void> {
  try {
    const { companyId } = input;
    const blueprint = await db
      .select({ retro: workflowBlueprints.retro })
      .from(workflowBlueprints)
      .where(eq(workflowBlueprints.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    const retro = blueprint?.retro;
    if (!retro || !retro.autoTrigger || !retro.routineId) return;
    const routineId = retro.routineId;
    const bounceThreshold = retro.bounceThreshold ?? DEFAULT_BOUNCE_THRESHOLD;
    const cooldownHours = retro.cooldownHours ?? DEFAULT_COOLDOWN_HOURS;

    const root = await resolveRoot(db, companyId, input.issueId);
    if (!root || root.originKind === ROUTINE_ORIGIN_KIND) return;
    const rootIdentifier = root.identifier ?? root.id;
    const treeIds = await ticketTreeIssueIds(db, companyId, root.id);
    if (treeIds.length === 0) return;
    const signal = await evaluateSignal(db, companyId, root.id, treeIds, input.signal, bounceThreshold);
    if (!signal) return;

    // Serialize per root so concurrent events cannot both pass the checks; the claim row is the cooldown record.
    const claimId = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`retro:${root.id}`}))`);
      const cutoff = new Date(Date.now() - cooldownHours * 3600_000);
      const recent = await tx
        .select({ id: retroTriggers.id })
        .from(retroTriggers)
        .where(
          and(
            eq(retroTriggers.companyId, companyId),
            eq(retroTriggers.rootIssueId, root.id),
            gt(retroTriggers.createdAt, cutoff),
          ),
        )
        .limit(1);
      if (recent.length > 0) return null;
      // An open retro issue is one created by a run of the retro routine whose variables name this root.
      const open = await tx.execute<{ id: string }>(sql`
        SELECT i.id FROM issues i
        JOIN routine_runs rr ON rr.linked_issue_id = i.id
        WHERE i.company_id = ${companyId}
          AND rr.company_id = ${companyId}
          AND rr.routine_id = ${routineId}
          AND rr.trigger_payload -> 'variables' ->> 'issueIdentifier' = ${rootIdentifier}
          AND i.status NOT IN ('done', 'cancelled')
        LIMIT 1
      `);
      if ((Array.isArray(open) ? open : (open as { rows: unknown[] }).rows).length > 0) return null;
      const [claim] = await tx
        .insert(retroTriggers)
        .values({ companyId, rootIssueId: root.id, signalKind: signal.kind, detail: signal.detail })
        .returning({ id: retroTriggers.id });
      return claim.id;
    });
    if (!claimId) return;

    try {
      const run = await (deps.runRoutine ?? ((id, body) => defaultRunRoutine(db, id, body)))(routineId, {
        source: "api",
        variables: {
          issueIdentifier: rootIdentifier,
          satisfactionScore: `unscored (auto: ${signal.kind})`,
          operatorFeedback: "",
        },
        idempotencyKey: `retro:${root.id}:${signal.kind}:${new Date().toISOString().slice(0, 10)}`,
      } as RunRoutine);
      await db.update(retroTriggers).set({ routineRunId: run.id }).where(eq(retroTriggers.id, claimId));
    } catch (err) {
      await db.delete(retroTriggers).where(eq(retroTriggers.id, claimId)).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    logger.warn({ err, companyId: input.companyId, issueId: input.issueId }, "retro auto-trigger failed");
  }
}

/** Fire-and-forget wrapper for hook sites. */
export function triggerRetroInBackground(db: Db, input: Parameters<typeof maybeTriggerRetro>[1]): void {
  void maybeTriggerRetro(db, input);
}
