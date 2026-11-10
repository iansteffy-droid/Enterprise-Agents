import { describe, expect, it } from "vitest";
import type { Issue, IssueBlockedInboxAttention, IssueExecutionState } from "@paperclipai/shared";
import { humanReviewSummary } from "./human-review";

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

function attention(overrides: Partial<IssueBlockedInboxAttention>): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "awaiting_decision",
    reason: "pending_board_decision",
    severity: "medium",
    stoppedSinceAt: null,
    owner: { type: "board", agentId: null, userId: null, label: "Board" },
    action: { label: "Decide approval", detail: "Approve, reject, or request revision." },
    sourceIssue: null,
    leafIssue: null,
    recoveryIssue: null,
    approvalId: null,
    interactionId: null,
    sampleIssueIdentifier: null,
    redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
    ...overrides,
  };
}

function issue(overrides: Partial<Issue>): Pick<Issue, "status" | "executionState" | "blockedInboxAttention"> {
  return {
    status: "in_review",
    executionState: null,
    blockedInboxAttention: null,
    ...overrides,
  } as Pick<Issue, "status" | "executionState" | "blockedInboxAttention">;
}

describe("humanReviewSummary", () => {
  it("returns null when the task is not in_review", () => {
    expect(humanReviewSummary(issue({ status: "in_progress" }))).toBeNull();
    expect(humanReviewSummary(issue({ status: "done" }))).toBeNull();
  });

  it("returns a generic label for a healthy human review stage", () => {
    const result = humanReviewSummary(
      issue({
        executionState: execState({
          currentStageType: "review",
          currentParticipant: { type: "user", userId: "u1", agentId: null },
        }),
      }),
    );
    expect(result?.label).toBe("Review & approve/reject");
  });

  it("distinguishes approval stages", () => {
    const result = humanReviewSummary(
      issue({
        executionState: execState({
          currentStageType: "approval",
          currentParticipant: { type: "user", userId: "u1", agentId: null },
        }),
      }),
    );
    expect(result?.label).toBe("Approve or reject");
  });

  it("returns null when the pending reviewer is an agent (agent-to-agent handoff)", () => {
    expect(
      humanReviewSummary(
        issue({
          executionState: execState({
            currentParticipant: { type: "agent", agentId: "a1", userId: null },
          }),
        }),
      ),
    ).toBeNull();
  });

  it("returns null when an agent is the reviewer even if an attention record exists", () => {
    expect(
      humanReviewSummary(
        issue({
          executionState: execState({
            currentParticipant: { type: "agent", agentId: "a1", userId: null },
          }),
          blockedInboxAttention: attention({}),
        }),
      ),
    ).toBeNull();
  });

  it("surfaces a board decision label from blockedInboxAttention", () => {
    const result = humanReviewSummary(
      issue({ blockedInboxAttention: attention({ action: { label: "Decide approval", detail: "Approve or reject." } }) }),
    );
    expect(result).toEqual({ label: "Decide approval", detail: "Approve or reject." });
  });

  it("surfaces a pending user question", () => {
    const result = humanReviewSummary(
      issue({
        blockedInboxAttention: attention({
          reason: "pending_user_decision",
          owner: { type: "user", agentId: null, userId: "u1", label: null },
          action: { label: "Answer question", detail: null },
        }),
      }),
    );
    expect(result).toEqual({ label: "Answer question", detail: null });
  });

  it("ignores attention owned by an agent", () => {
    expect(
      humanReviewSummary(
        issue({
          blockedInboxAttention: attention({
            owner: { type: "agent", agentId: "a1", userId: null, label: null },
            action: { label: "Choose disposition", detail: "x" },
          }),
        }),
      ),
    ).toBeNull();
  });

  it("prefers the precomputed attention label over the generic stage label", () => {
    const result = humanReviewSummary(
      issue({
        executionState: execState({
          currentParticipant: { type: "user", userId: "u1", agentId: null },
        }),
        blockedInboxAttention: attention({
          owner: { type: "user", agentId: null, userId: "u1", label: null },
          action: { label: "Answer question", detail: null },
        }),
      }),
    );
    expect(result?.label).toBe("Answer question");
  });
});
