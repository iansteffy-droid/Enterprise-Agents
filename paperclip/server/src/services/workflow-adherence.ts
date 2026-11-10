import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { activityLog, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type {
  WorkflowAdherence,
  WorkflowAdherenceEdge,
  WorkflowAdherenceEdgeKind,
  WorkflowBlueprint,
  WorkflowReworkLoop,
  WorkflowWorstTicket,
} from "@paperclipai/shared";

export const WINDOW_DAYS = 14;

export function reconstructChain(
  events: Array<{ agentId: string; t: number }>,
): Array<{ agentId: string; t: number }> {
  const out: Array<{ agentId: string; t: number }> = [];
  for (const e of events) {
    if (!e.agentId) continue;
    if (out.length && out[out.length - 1].agentId === e.agentId) continue;
    out.push(e);
  }
  return out;
}

export function classifyEdge(
  fromAgentId: string,
  toAgentId: string,
  order: Map<string, number>,
): WorkflowAdherenceEdgeKind {
  const a = order.get(fromAgentId);
  const b = order.get(toAgentId);
  if (a === undefined || b === undefined) return "offpath";
  if (b === a + 1) return "forward";
  if (b > a + 1) return "skip";
  return "backward"; // b <= a
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function workflowAdherenceService(db: Db) {
  return {
    async compute(companyId: string, blueprint: Pick<WorkflowBlueprint, "stages" | "returnEdges"> | null): Promise<WorkflowAdherence> {
      const now = Date.now();
      const generatedAt = new Date(now).toISOString();
      const lookback = new Date(now - WINDOW_DAYS * 86_400_000);

      // Build blueprint order map: agentId -> ordinal across the flattened spine.
      const order = new Map<string, number>();
      if (blueprint) {
        let ordinal = 0;
        for (const stage of [...blueprint.stages].sort((a, b) => a.position - b.position)) {
          for (const agentId of stage.agentIds) order.set(agentId, ordinal++);
        }
      }

      // Done issues in the window (completedAt is the recency anchor).
      const doneIssues = await db
        .select({ id: issues.id, identifier: issues.identifier })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.status, "done"), gte(issues.completedAt, lookback)));
      const identifierById = new Map(doneIssues.map((i) => [i.id, i.identifier]));
      const issueIds = doneIssues.map((i) => i.id);

      const empty: WorkflowAdherence = {
        adherenceRate: 0, cleanTicketCount: 0, ticketCount: 0,
        edges: [], reworkLoops: [], worstTickets: [], windowDays: WINDOW_DAYS, generatedAt,
      };
      if (issueIds.length === 0) return empty;

      // Time-ordered agent touches for those issues. checked_out + assignment changes carry the holder.
      const rows = await db
        .select({
          entityId: activityLog.entityId,
          action: activityLog.action,
          agentId: activityLog.agentId,
          details: activityLog.details,
          createdAt: activityLog.createdAt,
        })
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          inArray(activityLog.entityId, issueIds),
        ))
        .orderBy(asc(activityLog.createdAt));

      const touches = new Map<string, Array<{ agentId: string; t: number }>>();
      for (const r of rows) {
        let holder: string | null = null;
        if (r.action === "issue.checked_out" && r.agentId) holder = r.agentId;
        else if (r.details && typeof (r.details as Record<string, unknown>).assigneeAgentId === "string") {
          holder = (r.details as Record<string, string>).assigneeAgentId;
        }
        if (!holder) continue;
        const list = touches.get(r.entityId) ?? [];
        list.push({ agentId: holder, t: r.createdAt.getTime() });
        touches.set(r.entityId, list);
      }

      const edgeAgg = new Map<string, { from: string; to: string; count: number; dwell: number[] }>();
      const loopAgg = new Map<
        string,
        { from: string; to: string; count: number; tickets: Set<string>; examples: string[] }
      >();
      const worst: WorkflowWorstTicket[] = [];
      let cleanCount = 0;
      let ticketCount = 0;

      for (const [issueId, evs] of touches) {
        const chain = reconstructChain(evs);
        if (chain.length < 2) continue;
        ticketCount++;
        const seen = new Set<string>();
        let revisits = 0;
        let clean = true;
        for (let i = 0; i < chain.length - 1; i++) {
          const from = chain[i].agentId;
          const to = chain[i + 1].agentId;
          const kind = classifyEdge(from, to, order);
          const key = `${from}->${to}`;
          const agg = edgeAgg.get(key) ?? { from, to, count: 0, dwell: [] };
          agg.count++;
          agg.dwell.push(chain[i + 1].t - chain[i].t);
          edgeAgg.set(key, agg);
          if (kind === "backward" || kind === "skip") clean = false;
          if (kind === "backward") {
            const lk = loopAgg.get(key) ?? { from, to, count: 0, tickets: new Set<string>(), examples: [] };
            lk.count++;
            lk.tickets.add(issueId);
            const ident = identifierById.get(issueId);
            if (ident && lk.examples.length < 3 && !lk.examples.includes(ident)) lk.examples.push(ident);
            loopAgg.set(key, lk);
          }
        }
        for (const c of chain) {
          if (seen.has(c.agentId)) revisits++;
          else seen.add(c.agentId);
        }
        if (revisits > 0) clean = false;
        if (clean) cleanCount++;
        worst.push({
          issueId,
          identifier: identifierById.get(issueId) ?? issueId,
          hopCount: chain.length - 1,
          revisitCount: revisits,
        });
      }

      const edges: WorkflowAdherenceEdge[] = [...edgeAgg.values()].map((e) => ({
        fromAgentId: e.from,
        toAgentId: e.to,
        count: e.count,
        kind: classifyEdge(e.from, e.to, order),
        medianDwellMs: median(e.dwell),
      }));
      const reworkLoops: WorkflowReworkLoop[] = [...loopAgg.values()]
        .sort((a, b) => b.count - a.count)
        .map((l) => ({
          fromAgentId: l.from,
          toAgentId: l.to,
          count: l.count,
          ticketCount: l.tickets.size,
          exampleIssueIdentifiers: l.examples,
        }));
      worst.sort((a, b) => b.hopCount - a.hopCount || b.revisitCount - a.revisitCount);

      return {
        adherenceRate: ticketCount ? Math.round((cleanCount / ticketCount) * 1000) / 1000 : 0,
        cleanTicketCount: cleanCount,
        ticketCount,
        edges,
        reworkLoops,
        worstTickets: worst.slice(0, 10),
        windowDays: WINDOW_DAYS,
        generatedAt,
      };
    },
  };
}
