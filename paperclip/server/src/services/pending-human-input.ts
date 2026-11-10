import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, issueApprovals, issueThreadInteractions, issues } from "@paperclipai/db";
import type { PendingHumanInputItem, PendingHumanInputKind } from "@paperclipai/shared";
import { buildAgentAvatarUrl } from "./agents.js";

/**
 * Issue-thread interaction kinds that represent a request awaiting the human
 * board user. Agent-to-agent handoffs and already-resolved interactions are
 * excluded — only `pending` rows of these kinds are surfaced.
 */
const PENDING_INTERACTION_KINDS: PendingHumanInputKind[] = [
  "request_confirmation",
  "request_checkbox_confirmation",
  "ask_user_questions",
  "suggest_tasks",
];

/**
 * A request raised on a ticket that has since been closed is moot — the human
 * owes it nothing. Requests on these statuses are excluded from the list.
 */
const CLOSED_ISSUE_STATUSES = ["done", "cancelled"];

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * Resolve the human-facing message and the accept/reject button labels for an
 * approval. Approval action labels are currently fixed to "Approve"/"Reject".
 */
export function presentApproval(input: {
  type: string;
  payload: Record<string, unknown> | null | undefined;
}): { message: string; acceptLabel: string; rejectLabel: string; canResolveInline: boolean } {
  const payload = input.payload ?? {};
  const message =
    firstNonEmptyString(payload.message, payload.summary, payload.title)
    ?? `${input.type} approval`;
  return { message, acceptLabel: "Approve", rejectLabel: "Reject", canResolveInline: true };
}

/**
 * Resolve the human-facing message and button labels for a pending issue-thread
 * interaction. Button labels are read from the request payload so the dashboard
 * matches the labels shown on the ticket itself (falling back to the same
 * defaults the ticket cards use). Interactions that need structured input to
 * resolve (answering questions, selecting suggested tasks / checkbox options)
 * are flagged `canResolveInline: false` so the UI routes resolution to the
 * ticket rather than a two-button row.
 */
export function presentInteraction(input: {
  kind: string;
  payload: Record<string, unknown> | null | undefined;
  title: string | null;
  summary: string | null;
}): {
  message: string;
  acceptLabel: string;
  rejectLabel: string | null;
  canResolveInline: boolean;
} {
  const payload = input.payload ?? {};
  switch (input.kind) {
    case "request_confirmation":
      return {
        message: firstNonEmptyString(payload.prompt, input.title, input.summary) ?? "Confirm request",
        acceptLabel: firstNonEmptyString(payload.acceptLabel) ?? "Confirm",
        rejectLabel: firstNonEmptyString(payload.rejectLabel) ?? "Decline",
        canResolveInline: true,
      };
    case "request_checkbox_confirmation":
      return {
        message: firstNonEmptyString(payload.prompt, input.title, input.summary) ?? "Confirm selection",
        acceptLabel: firstNonEmptyString(payload.acceptLabel) ?? "Confirm selected",
        rejectLabel: firstNonEmptyString(payload.rejectLabel) ?? "Request changes",
        // Accepting requires selecting options (and may enforce min/max), so it
        // is resolved on the ticket, not inline.
        canResolveInline: false,
      };
    case "ask_user_questions":
      return {
        message: firstNonEmptyString(payload.title, input.title, input.summary) ?? "Answer questions",
        acceptLabel: firstNonEmptyString(payload.submitLabel) ?? "Submit answers",
        rejectLabel: null,
        // Answering requires the question form.
        canResolveInline: false,
      };
    case "suggest_tasks":
      return {
        message: firstNonEmptyString(input.title, input.summary) ?? "Review suggested tasks",
        acceptLabel: "Accept drafts",
        rejectLabel: "Reject",
        // Accepting creates issues from a (selectable) draft set — resolve on the ticket.
        canResolveInline: false,
      };
    default:
      return {
        message: firstNonEmptyString(input.title, input.summary) ?? "Pending request",
        acceptLabel: "Confirm",
        rejectLabel: "Decline",
        canResolveInline: false,
      };
  }
}

export function pendingHumanInputService(db: Db) {
  return {
    /**
     * Merged, oldest-first list of everything awaiting the human board user in a
     * company: pending governed approvals and pending issue-thread interactions.
     * Requests raised on tickets that are since done/cancelled are excluded.
     */
    list: async (companyId: string): Promise<PendingHumanInputItem[]> => {
      const [pendingApprovals, interactionRows] = await Promise.all([
        db
          .select({
            id: approvals.id,
            type: approvals.type,
            payload: approvals.payload,
            requestedByAgentId: approvals.requestedByAgentId,
            createdAt: approvals.createdAt,
          })
          .from(approvals)
          .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending"))),
        db
          .select({
            id: issueThreadInteractions.id,
            kind: issueThreadInteractions.kind,
            payload: issueThreadInteractions.payload,
            title: issueThreadInteractions.title,
            summary: issueThreadInteractions.summary,
            createdByAgentId: issueThreadInteractions.createdByAgentId,
            createdAt: issueThreadInteractions.createdAt,
            issueId: issues.id,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
          })
          .from(issueThreadInteractions)
          .innerJoin(issues, eq(issueThreadInteractions.issueId, issues.id))
          .where(
            and(
              eq(issueThreadInteractions.companyId, companyId),
              eq(issueThreadInteractions.status, "pending"),
              inArray(issueThreadInteractions.kind, PENDING_INTERACTION_KINDS),
              notInArray(issues.status, CLOSED_ISSUE_STATUSES),
            ),
          ),
      ]);

      // First linked *open* issue per approval, fetched in one query to avoid
      // N+1. Approvals whose linked tickets are all closed are dropped below;
      // approvals with no linked ticket at all are kept (company-level gates).
      const approvalIds = pendingApprovals.map((approval) => approval.id);
      const approvalIssueByApprovalId = new Map<
        string,
        { id: string; identifier: string | null; title: string }
      >();
      const approvalIdsWithLinks = new Set<string>();
      if (approvalIds.length > 0) {
        const links = await db
          .select({
            approvalId: issueApprovals.approvalId,
            issueId: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
          })
          .from(issueApprovals)
          .innerJoin(issues, eq(issueApprovals.issueId, issues.id))
          .where(inArray(issueApprovals.approvalId, approvalIds));
        for (const link of links) {
          approvalIdsWithLinks.add(link.approvalId);
          if (CLOSED_ISSUE_STATUSES.includes(link.status)) continue;
          if (!approvalIssueByApprovalId.has(link.approvalId)) {
            approvalIssueByApprovalId.set(link.approvalId, {
              id: link.issueId,
              identifier: link.identifier,
              title: link.title,
            });
          }
        }
      }

      // Resolve requesting agents (name + avatar) in one query.
      const agentIds = Array.from(
        new Set(
          [
            ...pendingApprovals.map((a) => a.requestedByAgentId),
            ...interactionRows.map((i) => i.createdByAgentId),
          ].filter((id): id is string => Boolean(id)),
        ),
      );
      const agentById = new Map<
        string,
        { id: string; name: string; avatarUrl: string | null }
      >();
      if (agentIds.length > 0) {
        const agentRows = await db
          .select({
            id: agents.id,
            name: agents.name,
            avatarAssetId: agents.avatarAssetId,
          })
          .from(agents)
          .where(inArray(agents.id, agentIds));
        for (const row of agentRows) {
          agentById.set(row.id, {
            id: row.id,
            name: row.name,
            avatarUrl: buildAgentAvatarUrl(row.avatarAssetId),
          });
        }
      }

      const items: PendingHumanInputItem[] = [];

      for (const approval of pendingApprovals) {
        // Linked only to closed tickets → the request died with the ticket.
        if (approvalIdsWithLinks.has(approval.id) && !approvalIssueByApprovalId.has(approval.id)) {
          continue;
        }
        const presentation = presentApproval({
          type: approval.type,
          payload: approval.payload as Record<string, unknown> | null,
        });
        items.push({
          id: approval.id,
          source: "approval",
          kind: "approval",
          issue: approvalIssueByApprovalId.get(approval.id) ?? null,
          message: presentation.message,
          acceptLabel: presentation.acceptLabel,
          rejectLabel: presentation.rejectLabel,
          canResolveInline: presentation.canResolveInline,
          requestingAgent: approval.requestedByAgentId
            ? agentById.get(approval.requestedByAgentId) ?? null
            : null,
          createdAt: new Date(approval.createdAt).toISOString(),
        });
      }

      for (const interaction of interactionRows) {
        const presentation = presentInteraction({
          kind: interaction.kind,
          payload: interaction.payload as unknown as Record<string, unknown> | null,
          title: interaction.title,
          summary: interaction.summary,
        });
        items.push({
          id: interaction.id,
          source: "interaction",
          kind: interaction.kind as PendingHumanInputKind,
          issue: {
            id: interaction.issueId,
            identifier: interaction.issueIdentifier,
            title: interaction.issueTitle,
          },
          message: presentation.message,
          acceptLabel: presentation.acceptLabel,
          rejectLabel: presentation.rejectLabel,
          canResolveInline: presentation.canResolveInline,
          requestingAgent: interaction.createdByAgentId
            ? agentById.get(interaction.createdByAgentId) ?? null
            : null,
          createdAt: new Date(interaction.createdAt).toISOString(),
        });
      }

      // Oldest-waiting first: the board should clear what has waited longest.
      items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return items;
    },
  };
}
