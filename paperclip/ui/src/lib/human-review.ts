import type { Issue } from "@paperclipai/shared";

/**
 * A concise, human-facing summary of the review a *human* still owes an
 * `in_review` task. Shared by the inbox "mine" review column and the
 * dashboard "Waiting on you" table so the two never diverge.
 */
export interface HumanReviewSummary {
  /** Short label for the cell, e.g. "Review & approve/reject", "Answer question". */
  label: string;
  /** Longer explanation suitable for a tooltip; null when there is nothing extra. */
  detail: string | null;
}

type HumanReviewIssue = Pick<Issue, "status" | "executionState" | "blockedInboxAttention">;

/**
 * Describe the human review a task needs, or `null` when the human owes nothing.
 *
 * Rules:
 * - Only `in_review` tasks are considered.
 * - A pending execution stage whose current participant is an **agent** is an
 *   agent-to-agent handoff — never surfaced (returns `null`).
 * - `blockedInboxAttention` (present only for tasks needing attention) carries a
 *   precomputed label for pending interactions, approvals, and decisions; it is
 *   surfaced only when its owner is a `user` or the `board`.
 * - Otherwise a healthy human review/approval stage yields a generic label.
 */
export function humanReviewSummary(issue: HumanReviewIssue): HumanReviewSummary | null {
  if (issue.status !== "in_review") return null;

  const state = issue.executionState;
  const participant = state?.status === "pending" ? state.currentParticipant : null;

  // Hard rule: an agent is the pending reviewer → agent handoff, not human review.
  if (participant?.type === "agent") return null;

  // Precomputed attention descriptor covers interactions, approvals, and
  // board/user decisions with real labels. Only surface human-owned ones.
  const attention = issue.blockedInboxAttention;
  if (attention && (attention.owner.type === "user" || attention.owner.type === "board")) {
    const label = attention.action.label?.trim();
    if (label) {
      const detail = attention.action.detail?.trim();
      return { label, detail: detail ? detail : null };
    }
  }

  // Healthy execution-policy human review stage with a human participant.
  if (participant?.type === "user") {
    return state?.currentStageType === "approval"
      ? { label: "Approve or reject", detail: "Approve or reject this stage to continue." }
      : { label: "Review & approve/reject", detail: "Review this stage, then approve or request changes." };
  }

  return null;
}
