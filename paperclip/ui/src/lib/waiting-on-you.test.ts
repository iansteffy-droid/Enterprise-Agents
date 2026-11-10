import { describe, expect, it } from "vitest";
import type { Agent, Issue, IssueExecutionState, PendingHumanInputItem } from "@paperclipai/shared";
import { buildWaitingOnYouItems } from "./waiting-on-you";

function execState(overrides: Partial<IssueExecutionState>): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: "stage-1",
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: null,
    returnAssignee: null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    ...overrides,
  };
}

function issue(overrides: Partial<Omit<Issue, "updatedAt">> & { updatedAt?: Date | string }): Issue {
  return {
    id: "issue-1",
    identifier: "ACME-1",
    title: "Ship the thing",
    status: "in_review",
    executionState: null,
    blockedInboxAttention: null,
    assigneeAgentId: null,
    updatedAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  } as unknown as Issue;
}

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    name: "Barclay",
    avatarUrl: "/api/assets/a1/content",
    ...overrides,
  } as unknown as Agent;
}

function serverItem(overrides: Partial<PendingHumanInputItem>): PendingHumanInputItem {
  return {
    id: "approval-1",
    source: "approval",
    kind: "approval",
    issue: null,
    message: "Deploy to prod?",
    acceptLabel: "Approve",
    rejectLabel: "Reject",
    canResolveInline: true,
    requestingAgent: null,
    createdAt: "2026-07-20T09:00:00.000Z",
    ...overrides,
  };
}

const humanReviewState = execState({
  currentParticipant: { type: "user", agentId: null, userId: "user-1" },
});

describe("buildWaitingOnYouItems", () => {
  it("passes server items through untouched when there are no issues", () => {
    const item = serverItem({});
    expect(
      buildWaitingOnYouItems({ pendingHumanInput: [item], issues: [], agents: [] }),
    ).toEqual([item]);
  });

  it("derives a ticket-linked review row for an in_review issue awaiting a human", () => {
    const items = buildWaitingOnYouItems({
      pendingHumanInput: [],
      issues: [issue({ executionState: humanReviewState })],
      agents: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "review:issue-1",
      source: "review",
      kind: "review",
      issue: { id: "issue-1", identifier: "ACME-1", title: "Ship the thing" },
      acceptLabel: "Review",
      rejectLabel: null,
      canResolveInline: false,
      createdAt: "2026-07-20T10:00:00.000Z",
    });
    expect(items[0].message).toContain("Review & approve/reject");
  });

  it("derives a review row for an in_review ticket assigned to a user with no execution policy", () => {
    const items = buildWaitingOnYouItems({
      pendingHumanInput: [],
      issues: [
        issue({ assigneeUserId: "local-board", createdByAgentId: "agent-1" }),
      ],
      agents: [agent({})],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "review:issue-1",
      source: "review",
      canResolveInline: false,
      acceptLabel: "Review",
    });
    expect(items[0].message).toContain("Review & mark done");
    expect(items[0].requestingAgent?.id).toBe("agent-1");
  });

  it("does not surface in_review tickets assigned to an agent (agent-to-agent review)", () => {
    const items = buildWaitingOnYouItems({
      pendingHumanInput: [],
      issues: [issue({ assigneeAgentId: "agent-2" })],
      agents: [],
    });
    expect(items).toEqual([]);
  });

  it("does not surface agent-to-agent review handoffs or non-review issues", () => {
    const items = buildWaitingOnYouItems({
      pendingHumanInput: [],
      issues: [
        issue({
          id: "issue-agent",
          executionState: execState({
            currentParticipant: { type: "agent", agentId: "agent-2", userId: null },
          }),
        }),
        issue({ id: "issue-open", status: "in_progress", executionState: humanReviewState }),
      ],
      agents: [],
    });
    expect(items).toEqual([]);
  });

  it("skips the review row when the ticket already has a pending request row", () => {
    const items = buildWaitingOnYouItems({
      pendingHumanInput: [
        serverItem({
          id: "interaction-1",
          source: "interaction",
          kind: "ask_user_questions",
          issue: { id: "issue-1", identifier: "ACME-1", title: "Ship the thing" },
        }),
      ],
      issues: [issue({ executionState: humanReviewState })],
      agents: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("interaction-1");
  });

  it("attributes the review to the return assignee, falling back to the agent assignee", () => {
    const fromReturnAssignee = buildWaitingOnYouItems({
      pendingHumanInput: [],
      issues: [
        issue({
          executionState: execState({
            currentParticipant: { type: "user", agentId: null, userId: "user-1" },
            returnAssignee: { type: "agent", agentId: "agent-1", userId: null },
          }),
        }),
      ],
      agents: [agent({})],
    });
    expect(fromReturnAssignee[0].requestingAgent).toEqual({
      id: "agent-1",
      name: "Barclay",
      avatarUrl: "/api/assets/a1/content",
    });

    const fromAssignee = buildWaitingOnYouItems({
      pendingHumanInput: [],
      issues: [issue({ executionState: humanReviewState, assigneeAgentId: "agent-1" })],
      agents: [agent({})],
    });
    expect(fromAssignee[0].requestingAgent?.id).toBe("agent-1");
  });

  it("sorts merged rows newest first", () => {
    const items = buildWaitingOnYouItems({
      pendingHumanInput: [serverItem({ createdAt: "2026-07-20T11:00:00.000Z" })],
      issues: [issue({ executionState: humanReviewState, updatedAt: "2026-07-20T10:00:00.000Z" })],
      agents: [],
    });
    expect(items.map((item) => item.id)).toEqual(["approval-1", "review:issue-1"]);
  });

  it("drops server requests whose ticket is done or cancelled", () => {
    const items = buildWaitingOnYouItems({
      pendingHumanInput: [
        serverItem({
          id: "interaction-done",
          source: "interaction",
          kind: "request_confirmation",
          issue: { id: "issue-done", identifier: "ACME-2", title: "Shipped" },
        }),
        serverItem({
          id: "interaction-cancelled",
          source: "interaction",
          kind: "request_confirmation",
          issue: { id: "issue-cancelled", identifier: "ACME-3", title: "Abandoned" },
        }),
        serverItem({ id: "approval-unlinked", issue: null }),
      ],
      issues: [
        issue({ id: "issue-done", status: "done" }),
        issue({ id: "issue-cancelled", status: "cancelled" }),
      ],
      agents: [],
    });
    expect(items.map((item) => item.id)).toEqual(["approval-unlinked"]);
  });
});
