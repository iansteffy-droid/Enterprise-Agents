// Retrospectives service.
//
// Surfaces every crew-retrospective proposal as a trackable list. Content (the
// proposals themselves) is always re-derived from the retro issue's comment;
// only each point's status and proposal reference are persisted in
// `retro_point_status`. The retro facilitator agent records the reference
// (PR URL or `branch:<name>`); the human sets merged or rejected.

import { and, asc, eq, inArray, like } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { feedbackVotes, issueComments, issues, retroPointStatus } from "@paperclipai/db";
import {
  DEFAULT_RETRO_POINT_SORT,
  computeRetroPointPriority,
  DEFAULT_RETRO_POINT_STATUS,
  isRetroPointStatus,
  isRetroProposalRef,
  sortRetroPoints,
  type RetroPoint,
  type RetroPointStatus,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { parseReviewedIdentifierFromDescription, parseRetroComment } from "./retro-points-parser.js";

/** Titles of retro execution tickets start with this (em-dash form). */
const RETRO_TITLE_PREFIX = "Crew retrospective";

/** `${retroIssueId}_${proposalKey}`, the proposal key being the row number (plus `.n` for a repeat). */
function buildPointKey(retroIssueId: string, proposalKey: string): string {
  return `${retroIssueId}_${proposalKey}`;
}

/** Down-votes with a written reason on a retro's comment(s). */
function collectDownvoteReasons(
  votes: Array<{ vote: string; reason: string | null }>,
): string[] {
  return votes
    .filter((vote) => vote.vote === "down" && typeof vote.reason === "string" && vote.reason.trim().length > 0)
    .map((vote) => vote.reason!.trim());
}

/** `${retroIssueId}_${number}[.${occurrence}]` → its parts; null when malformed. */
function parsePointKey(pointKey: string): { retroIssueId: string; number: number } | null {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(\d+)(?:\.\d+)?$/i.exec(pointKey);
  if (!match) return null;
  return { retroIssueId: match[1]!, number: Number.parseInt(match[2]!, 10) };
}

export interface SetRetroPointStatusInput {
  companyId: string;
  pointKey: string;
  /** Raw status value; validated against open | merged | rejected here (other → 422). Absent keeps the stored status. */
  status?: string;
  /** PR URL or `branch:<name>` (other → 422); null clears it; absent keeps the stored reference. */
  proposalRef?: string | null;
  /** Absent keeps the stored note. */
  note?: string | null;
  /** Exactly one of the two actor ids is set: the board user or the agent of the write. */
  updatedByUserId?: string | null;
  updatedByAgentId?: string | null;
}

export function retroPointsService(db: Db) {
  return {
    /**
     * Build the ranked list of retro points for a company. Derives everything
     * from retro tickets + their authoring comment; joins operator votes and
     * any stored status; ranks with the deterministic default priority.
     */
    listRetroPoints: async (companyId: string): Promise<RetroPoint[]> => {
      // 1. Find retro execution tickets by title prefix.
      const retroIssues = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          description: issues.description,
          createdAt: issues.createdAt,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), like(issues.title, `${RETRO_TITLE_PREFIX}%`)));

      if (retroIssues.length === 0) return [];

      const retroIssueIds = retroIssues.map((issue) => issue.id);

      // 2. Fetch every comment on those retro tickets (earliest first) so we can
      //    pick the authoring comment per retro.
      const commentRows = await db
        .select({
          id: issueComments.id,
          issueId: issueComments.issueId,
          body: issueComments.body,
          authorAgentId: issueComments.authorAgentId,
          createdAt: issueComments.createdAt,
          deletedAt: issueComments.deletedAt,
        })
        .from(issueComments)
        .where(and(eq(issueComments.companyId, companyId), inArray(issueComments.issueId, retroIssueIds)))
        .orderBy(asc(issueComments.createdAt));

      // 3. Operator votes on those comments (for downvote reasons per retro).
      const commentIds = commentRows.map((row) => row.id);
      const voteRows = commentIds.length
        ? await db
            .select({
              targetId: feedbackVotes.targetId,
              vote: feedbackVotes.vote,
              reason: feedbackVotes.reason,
            })
            .from(feedbackVotes)
            .where(
              and(
                eq(feedbackVotes.companyId, companyId),
                eq(feedbackVotes.targetType, "issue_comment"),
                inArray(feedbackVotes.targetId, commentIds),
              ),
            )
        : [];

      const votesByComment = new Map<string, Array<{ vote: string; reason: string | null }>>();
      for (const vote of voteRows) {
        const list = votesByComment.get(vote.targetId) ?? [];
        list.push({ vote: vote.vote, reason: vote.reason });
        votesByComment.set(vote.targetId, list);
      }

      // Pick the earliest non-deleted authoring comment per retro (falls back to
      // the earliest comment of any kind if none is agent-authored).
      const authoringCommentByIssue = new Map<string, (typeof commentRows)[number]>();
      for (const row of commentRows) {
        if (row.deletedAt) continue;
        if (!authoringCommentByIssue.has(row.issueId) && row.authorAgentId) {
          authoringCommentByIssue.set(row.issueId, row);
        }
      }
      for (const row of commentRows) {
        if (row.deletedAt) continue;
        if (!authoringCommentByIssue.has(row.issueId)) {
          authoringCommentByIssue.set(row.issueId, row);
        }
      }

      // 4. Load stored operator statuses for this company (only rows that exist).
      const statusRows = await db
        .select()
        .from(retroPointStatus)
        .where(eq(retroPointStatus.companyId, companyId));
      const statusByKey = new Map(statusRows.map((row) => [row.pointKey, row]));

      // 5. Resolve reviewed tickets referenced by the retros so we can link them.
      const points: RetroPoint[] = [];
      const reviewedIdentifiers = new Set<string>();
      const parsedByRetro: Array<{
        retro: (typeof retroIssues)[number];
        reviewedIdentifier: string | null;
        parsed: ReturnType<typeof parseRetroComment>;
        downvoteReasons: string[];
      }> = [];

      for (const retro of retroIssues) {
        const authoringComment = authoringCommentByIssue.get(retro.id);
        if (!authoringComment) continue; // no comment to parse → skip (graceful)
        const parsed = parseRetroComment(authoringComment.body);
        if (parsed.proposals.length === 0) continue; // unparseable/no proposals → skip

        const reviewedIdentifier =
          parsed.reviewedIdentifier ??
          parseReviewedIdentifierFromDescription(retro.description) ??
          retro.identifier;
        if (reviewedIdentifier) reviewedIdentifiers.add(reviewedIdentifier);

        parsedByRetro.push({
          retro,
          reviewedIdentifier,
          parsed,
          downvoteReasons: collectDownvoteReasons(votesByComment.get(authoringComment.id) ?? []),
        });
      }

      const reviewedByIdentifier = new Map<string, { id: string; title: string }>();
      if (reviewedIdentifiers.size > 0) {
        const reviewedRows = await db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              inArray(issues.identifier, [...reviewedIdentifiers]),
            ),
          );
        for (const row of reviewedRows) {
          if (row.identifier) reviewedByIdentifier.set(row.identifier, { id: row.id, title: row.title });
        }
      }

      // 6. Assemble each proposal into a ranked point.
      for (const { retro, reviewedIdentifier, parsed, downvoteReasons } of parsedByRetro) {
        const reviewed = reviewedIdentifier ? reviewedByIdentifier.get(reviewedIdentifier) ?? null : null;
        for (const proposal of parsed.proposals) {
          const impact = proposal.impact ?? 0;
          const effort = proposal.effort ?? 0;
          const pointKey = buildPointKey(retro.id, proposal.key);
          const stored = statusByKey.get(pointKey);
          points.push({
            pointKey,
            retroIssueId: retro.id,
            retroIdentifier: retro.identifier,
            retroCreatedAt: retro.createdAt.toISOString(),
            reviewedIssueId: reviewed?.id ?? null,
            reviewedIdentifier: reviewedIdentifier ?? null,
            reviewedTitle: reviewed?.title ?? null,
            number: proposal.number,
            change: proposal.change,
            targetFile: proposal.targetFile,
            scope: proposal.scope,
            impact,
            effort,
            priority: computeRetroPointPriority(impact, effort),
            status: (stored?.status as RetroPointStatus | undefined) ?? DEFAULT_RETRO_POINT_STATUS,
            proposalRef: stored?.proposalRef ?? null,
            note: stored?.note ?? null,
            updatedAt: stored?.updatedAt ? stored.updatedAt.toISOString() : null,
            why: {
              score: parsed.operatorScore,
              operatorFeedback: parsed.operatorFeedback,
              rootCauses: proposal.rootCause ?? parsed.rootCauses,
              downvoteReasons,
            },
          });
        }
      }

      return sortRetroPoints(points, DEFAULT_RETRO_POINT_SORT);
    },

    /**
     * Upsert a point's status and/or proposal reference. Company-scoped: the
     * point must belong to a retro issue of this company (404 otherwise).
     * Rejects a status outside open | merged | rejected and a reference that is
     * neither a PR URL nor `branch:<name>` (422). Absent fields keep their
     * stored values; a first write without a status stores "open".
     */
    setRetroPointStatus: async (input: SetRetroPointStatusInput) => {
      if (input.status !== undefined && !isRetroPointStatus(input.status)) {
        throw unprocessable(`Unknown retro point status: ${String(input.status)}`);
      }
      if (input.proposalRef !== undefined && input.proposalRef !== null && !isRetroProposalRef(input.proposalRef)) {
        throw unprocessable("proposalRef must be a PR URL or branch:<name>");
      }

      const parsedKey = parsePointKey(input.pointKey);
      const retro = parsedKey
        ? await db
            .select({ id: issues.id })
            .from(issues)
            .where(
              and(
                eq(issues.id, parsedKey.retroIssueId),
                eq(issues.companyId, input.companyId),
                like(issues.title, `${RETRO_TITLE_PREFIX}%`),
              ),
            )
            .then((rows) => rows[0] ?? null)
        : null;
      if (!retro) throw notFound("Retro point not found");

      const note =
        input.note === undefined
          ? undefined
          : typeof input.note === "string" && input.note.trim().length > 0
            ? input.note.trim()
            : null;
      const proposalRef = input.proposalRef === undefined ? undefined : input.proposalRef;
      const actor = {
        updatedByUserId: input.updatedByUserId ?? null,
        updatedByAgentId: input.updatedByAgentId ?? null,
      };
      const now = new Date();
      const [row] = await db
        .insert(retroPointStatus)
        .values({
          companyId: input.companyId,
          pointKey: input.pointKey,
          status: input.status ?? DEFAULT_RETRO_POINT_STATUS,
          proposalRef: proposalRef ?? null,
          note: note ?? null,
          ...actor,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [retroPointStatus.companyId, retroPointStatus.pointKey],
          set: {
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(proposalRef !== undefined ? { proposalRef } : {}),
            ...(note !== undefined ? { note } : {}),
            ...actor,
            updatedAt: now,
          },
        })
        .returning();
      return row!;
    },
  };
}

// Re-export the parser primitives for tests / reuse.
export { parseRetroComment, parseReviewedIdentifierFromTitle } from "./retro-points-parser.js";
