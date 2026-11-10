import type { Agent, Issue, PendingHumanInputItem } from "@paperclipai/shared";
import { humanReviewSummary } from "./human-review";

/**
 * One row in the dashboard "Waiting on you" table: either a server-listed
 * pending request (governed approval / issue-thread interaction) or a review
 * handoff — a ticket sitting `in_review` that waits on the human, either via
 * an execution-policy stage or
 * by being assigned to a user directly.
 *
 * Review rows are synthesized client-side from the issues list instead of the
 * `/pending-human-input` endpoint on purpose: the live event stream already
 * keeps the issues query fresh on every issue event, so reviews stay live
 * without a second endpoint or any polling.
 */
export type WaitingOnYouItem =
  | PendingHumanInputItem
  | (Omit<PendingHumanInputItem, "source" | "kind"> & { source: "review"; kind: "review" });

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/**
 * Merge the server's pending-human-input list with review handoffs derived
 * from the issues list, newest first.
 *
 * A ticket that already has a pending approval/interaction row keeps that row;
 * the derived review row would be a duplicate call to action for the same
 * ticket, so it is skipped. Requests whose ticket is done/cancelled are
 * dropped — the request died with the ticket.
 */
export function buildWaitingOnYouItems(input: {
  pendingHumanInput: PendingHumanInputItem[] | undefined;
  issues: Issue[] | undefined;
  agents: Agent[] | undefined;
}): WaitingOnYouItem[] {
  const agentById = new Map((input.agents ?? []).map((agent) => [agent.id, agent]));
  const issueStatusById = new Map((input.issues ?? []).map((issue) => [issue.id, issue.status]));

  // The server list also excludes closed tickets, but the issues query refetches
  // on every issue event while the pending list does not — filtering here makes
  // a request row disappear the moment its ticket is marked done/cancelled.
  const serverItems = (input.pendingHumanInput ?? []).filter((item) => {
    if (!item.issue) return true;
    const status = issueStatusById.get(item.issue.id);
    return status !== "done" && status !== "cancelled";
  });
  const issueIdsWithServerItems = new Set(
    serverItems.flatMap((item) => (item.issue ? [item.issue.id] : [])),
  );

  const reviewItems: WaitingOnYouItem[] = (input.issues ?? []).flatMap((issue) => {
    if (issueIdsWithServerItems.has(issue.id)) return [];

    // Execution-policy reviews: a pending stage whose participant is the human.
    const policyReview = humanReviewSummary(issue);
    // Plain review handoffs: the crew moves the ticket to in_review and assigns
    // it to a user directly, with no execution policy involved. An agent
    // assignee (or any execution state, which humanReviewSummary already
    // judged) means the review is not the human's.
    const plainHumanReview =
      !policyReview
      && issue.status === "in_review"
      && !issue.executionState
      && !!issue.assigneeUserId
      && !issue.assigneeAgentId;
    if (!policyReview && !plainHumanReview) return [];

    const review = policyReview ?? {
      label: "Review & mark done",
      detail: "Review the work handed to you, then mark the ticket done or send it back.",
    };

    // "Requested by" is the agent the ticket returns to after review — the one
    // that handed the work off — falling back to the current agent assignee,
    // then to the agent that created the ticket.
    const returnAssignee = issue.executionState?.returnAssignee;
    const requestingAgentId =
      (returnAssignee?.type === "agent" ? returnAssignee.agentId : null)
      ?? issue.assigneeAgentId
      ?? issue.createdByAgentId
      ?? null;
    const agent = requestingAgentId ? agentById.get(requestingAgentId) : undefined;

    return [{
      id: `review:${issue.id}`,
      source: "review" as const,
      kind: "review" as const,
      issue: { id: issue.id, identifier: issue.identifier, title: issue.title },
      message: review.detail ? `${review.label} — ${review.detail}` : review.label,
      acceptLabel: "Review",
      rejectLabel: null,
      // Reviews are decided on the ticket (approve / request changes there).
      canResolveInline: false,
      requestingAgent: agent
        ? { id: agent.id, name: agent.name, avatarUrl: agent.avatarUrl }
        : null,
      createdAt: toIsoString(issue.updatedAt),
    }];
  });

  return [...serverItems, ...reviewItems].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
