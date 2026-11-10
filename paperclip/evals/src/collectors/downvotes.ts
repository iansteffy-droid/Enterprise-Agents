import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, feedbackExports, feedbackVotes, issueComments } from "@paperclipai/db";
import type { LedgerEntry } from "../types.js";

/**
 * Read-only. Harvests down-votes on agent-authored issue comments for one company
 * and normalizes them into ledger entries. Up-votes, user-authored comments, and
 * document-revision votes are excluded.
 */
export async function collectDownvoteFailures(db: Db, companyId: string): Promise<LedgerEntry[]> {
  const rows = await db
    .select({
      voteId: feedbackVotes.id,
      issueId: feedbackVotes.issueId,
      reason: feedbackVotes.reason,
      voteCreatedAt: feedbackVotes.createdAt,
      agentId: issueComments.authorAgentId,
      runId: issueComments.createdByRunId,
      agentName: agents.name,
      exportId: feedbackExports.exportId,
    })
    .from(feedbackVotes)
    .innerJoin(issueComments, eq(issueComments.id, sql<string>`${feedbackVotes.targetId}::uuid`))
    .leftJoin(agents, eq(agents.id, issueComments.authorAgentId))
    .leftJoin(feedbackExports, eq(feedbackExports.feedbackVoteId, feedbackVotes.id))
    .where(
      and(
        eq(feedbackVotes.companyId, companyId),
        eq(feedbackVotes.vote, "down"),
        eq(feedbackVotes.targetType, "issue_comment"),
        isNotNull(issueComments.authorAgentId),
      ),
    );

  return rows
    .filter((r): r is typeof r & { agentId: string } => r.agentId != null)
    .map((r) => ({
      id: `downvote:${r.voteId}`,
      agentId: r.agentId,
      agentName: r.agentName ?? null,
      signalType: "downvote" as const,
      issueId: r.issueId,
      runId: r.runId ?? null,
      reason: r.reason ?? null,
      traceRef: r.exportId ?? null,
      detectedAt: r.voteCreatedAt.toISOString(),
      status: "new" as const,
    }));
}
