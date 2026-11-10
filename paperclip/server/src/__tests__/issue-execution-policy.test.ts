import { describe, expect, it } from "vitest";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy, parseIssueExecutionState, resumeHeldExecutionState } from "../services/issue-execution-policy.ts";
import type { IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";

const coderAgentId = "11111111-1111-4111-8111-111111111111";
const qaAgentId = "22222222-2222-4222-8222-222222222222";
const ctoAgentId = "33333333-3333-4333-8333-333333333333";
const ctoUserId = "cto-user";
const boardUserId = "board-user";

function makePolicy(
  stages: Array<{ type: "review" | "approval"; participants: Array<{ type: "agent" | "user"; agentId?: string; userId?: string }> }>,
) {
  return normalizeIssueExecutionPolicy({ stages })!;
}

function twoStagePolicy() {
  return makePolicy([
    { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
    { type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
  ]);
}

function reviewOnlyPolicy() {
  return makePolicy([
    { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
  ]);
}

function approvalOnlyPolicy() {
  return makePolicy([
    { type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
  ]);
}

describe("normalizeIssueExecutionPolicy", () => {
  it("returns null for null/undefined input", () => {
    expect(normalizeIssueExecutionPolicy(null)).toBeNull();
    expect(normalizeIssueExecutionPolicy(undefined)).toBeNull();
  });

  it("returns null when stages are empty", () => {
    expect(normalizeIssueExecutionPolicy({ stages: [] })).toBeNull();
  });

  it("throws when all participants are invalid (missing agentId)", () => {
    expect(() =>
      normalizeIssueExecutionPolicy({
        stages: [{ type: "review", participants: [{ type: "agent" }] }],
      }),
    ).toThrow("Invalid execution policy");
  });

  it("deduplicates participants within a stage", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: qaAgentId },
          ],
        },
      ],
    });
    expect(result!.stages[0].participants).toHaveLength(1);
  });

  it("assigns UUIDs to stages and participants", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
      ],
    });
    expect(result!.stages[0].id).toBeDefined();
    expect(result!.stages[0].participants[0].id).toBeDefined();
  });

  it("always sets commentRequired to true", () => {
    const result = normalizeIssueExecutionPolicy({
      commentRequired: false,
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
      ],
    });
    expect(result!.commentRequired).toBe(true);
  });

  it("defaults mode to normal", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
      ],
    });
    expect(result!.mode).toBe("normal");
  });

  it("rejects approvalsNeeded values above 1", () => {
    expect(() =>
      normalizeIssueExecutionPolicy({
        stages: [
          {
            type: "review",
            approvalsNeeded: 2,
            participants: [{ type: "agent", agentId: qaAgentId }],
          },
        ],
      }),
    ).toThrow("Invalid execution policy");
  });

  it("throws for invalid input", () => {
    expect(() => normalizeIssueExecutionPolicy({ stages: [{ type: "invalid_type" }] })).toThrow();
  });

  it("keeps monitor-only policies", () => {
    const result = normalizeIssueExecutionPolicy({
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment",
        externalRef: "https://example.test/deploy?token=secret",
      },
      stages: [],
    });
    expect(result).toMatchObject({
      stages: [],
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment",
        scheduledBy: "assignee",
        externalRef: "[redacted]",
      },
    });
  });
});

describe("parseIssueExecutionState", () => {
  it("returns null for null/undefined", () => {
    expect(parseIssueExecutionState(null)).toBeNull();
    expect(parseIssueExecutionState(undefined)).toBeNull();
  });

  it("returns null for invalid shape", () => {
    expect(parseIssueExecutionState({ status: "bogus" })).toBeNull();
  });

  it("parses a valid state", () => {
    const state = parseIssueExecutionState({
      status: "pending",
      currentStageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: qaAgentId },
      returnAssignee: { type: "agent", agentId: coderAgentId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    });
    expect(state).not.toBeNull();
    expect(state!.status).toBe("pending");
  });
});

describe("issue execution policy transitions", () => {
  describe("happy path: executor → review → approval → done", () => {
    const policy = twoStagePolicy();

    it("routes executor completion into review", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Implemented the feature",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        returnAssignee: { type: "agent", agentId: coderAgentId },
      });
      expect(result.decision).toBeUndefined();
    });

    it("carries loose review instructions on the pending handoff", () => {
      const reviewInstructions = [
        "Please focus on whether the migration path is reversible.",
        "",
        "- Check failure handling",
        "- Call out any unclear operator instructions",
      ].join("\n");

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Implemented the migration",
        reviewRequest: { instructions: reviewInstructions },
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
        reviewRequest: { instructions: reviewInstructions },
      });
    });

    it("clears loose review instructions with explicit null during a stage transition", () => {
      const reviewStageId = policy.stages[0].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            reviewRequest: { instructions: "Old review request" },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_review",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
        reviewRequest: null,
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
        reviewRequest: null,
      });
    });

    it("reviewer approves → advances to approval stage", () => {
      const reviewStageId = policy.stages[0].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        executionDecision: "approve",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "QA signoff complete",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBeNull();
      expect(result.patch.assigneeUserId).toBe(ctoUserId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "approval",
        completedStageIds: [reviewStageId],
        currentParticipant: { type: "user", userId: ctoUserId },
      });
      expect(result.decision).toMatchObject({
        stageId: reviewStageId,
        stageType: "review",
        outcome: "approved",
      });
    });

    it("lets a reviewer provide loose instructions for the next approval stage", () => {
      const reviewStageId = policy.stages[0].id;
      const approvalInstructions = "Please decide whether this is ready to ship, with any launch caveats.";
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            reviewRequest: { instructions: "Review the implementation details." },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        executionDecision: "approve",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "QA signoff complete",
        reviewRequest: { instructions: approvalInstructions },
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: ctoUserId },
        reviewRequest: { instructions: approvalInstructions },
      });
    });

    it("approver approves → marks completed (allows done)", () => {
      const reviewStageId = policy.stages[0].id;
      const approvalStageId = policy.stages[1].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: ctoUserId,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: approvalStageId,
            currentStageIndex: 1,
            currentStageType: "approval",
            currentParticipant: { type: "user", userId: ctoUserId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [reviewStageId],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { userId: ctoUserId },
        commentBody: "Approved, ship it",
        executionDecision: "approve",
      });

      expect(result.patch.executionState).toMatchObject({
        status: "completed",
        completedStageIds: expect.arrayContaining([reviewStageId, approvalStageId]),
        lastDecisionOutcome: "approved",
      });
      expect(result.decision).toMatchObject({
        stageId: approvalStageId,
        stageType: "approval",
        outcome: "approved",
      });
      // status should NOT be overridden — caller can set done
      expect(result.patch.status).toBeUndefined();
    });
  });

  describe("explicit executionDecision", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;
    const approvalStageId = policy.stages[1].id;
    const pendingIssue = (stageIndex: 0 | 1) => ({
      status: "in_review",
      assigneeAgentId: stageIndex === 0 ? qaAgentId : null,
      assigneeUserId: stageIndex === 0 ? null : ctoUserId,
      executionPolicy: policy,
      executionState: {
        status: "pending" as const,
        currentStageId: stageIndex === 0 ? reviewStageId : approvalStageId,
        currentStageIndex: stageIndex,
        currentStageType: stageIndex === 0 ? ("review" as const) : ("approval" as const),
        currentParticipant: stageIndex === 0
          ? { type: "agent" as const, agentId: qaAgentId }
          : { type: "user" as const, userId: ctoUserId },
        returnAssignee: { type: "agent" as const, agentId: coderAgentId },
        completedStageIds: stageIndex === 0 ? [] : [reviewStageId],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    const agentCall = (extra: Record<string, unknown>) =>
      applyIssueExecutionPolicyTransition({
        issue: pendingIssue(0),
        policy,
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "Reviewed",
        ...extra,
      });

    it("approve without status advances the stage", () => {
      const result = agentCall({ executionDecision: "approve" });
      expect(result.decision).toMatchObject({ outcome: "approved", stageType: "review" });
      expect(result.patch.executionState).toMatchObject({ status: "pending", currentStageType: "approval" });
    });

    it("approve with status done (matching pair) advances the stage", () => {
      const result = agentCall({ executionDecision: "approve", requestedStatus: "done" });
      expect(result.decision).toMatchObject({ outcome: "approved" });
    });

    it("request_changes without status returns to the return assignee", () => {
      const result = agentCall({ executionDecision: "request_changes" });
      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
      expect(result.decision).toMatchObject({ outcome: "changes_requested" });
    });

    it("request_changes with status in_progress (matching pair) is accepted", () => {
      const result = agentCall({ executionDecision: "request_changes", requestedStatus: "in_progress" });
      expect(result.decision).toMatchObject({ outcome: "changes_requested" });
    });

    it.each([
      ["approve", "in_progress"],
      ["request_changes", "done"],
    ])("rejects mismatched pair %s + %s with a stable 422 code", (decision, status) => {
      try {
        agentCall({ executionDecision: decision, requestedStatus: status });
        expect.unreachable("expected a 422");
      } catch (err) {
        expect(err).toMatchObject({
          status: 422,
          details: { code: "execution_decision_status_mismatch" },
        });
      }
    });

    it("final approval without status sets status done", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: pendingIssue(1),
        policy,
        requestedAssigneePatch: {},
        actor: { userId: ctoUserId },
        commentBody: "Ship it",
        executionDecision: "approve",
      });
      expect(result.patch.status).toBe("done");
      expect(result.patch.executionState).toMatchObject({ status: "completed" });
    });

    it("an agent's bare status change on an active stage is refused with execution_decision_required", () => {
      for (const status of ["done", "in_progress"]) {
        try {
          agentCall({ requestedStatus: status });
          expect.unreachable("expected a 422");
        } catch (err) {
          expect(err).toMatchObject({ status: 422, details: { code: "execution_decision_required" } });
        }
      }
    });

    it("an executor's bare done with no executionDecision still submits the issue for review", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });
      expect(result.patch.status).toBe("in_review");
      expect(result.patch.executionState).toMatchObject({ status: "pending", currentStageType: "review" });
    });

    it("a board user's bare status done is still not an approval", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: pendingIssue(1),
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { userId: ctoUserId },
          commentBody: "Ship it",
        }),
      ).toThrow(/requires the Approve action/);
    });
  });

  describe("changes requested flow", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("reviewer requests changes → returns to executor", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        executionDecision: "request_changes",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "Needs another pass on edge cases",
      });

      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "changes_requested",
        currentStageType: "review",
        returnAssignee: { type: "agent", agentId: coderAgentId },
        lastDecisionOutcome: "changes_requested",
      });
      expect(result.decision).toMatchObject({
        stageId: reviewStageId,
        stageType: "review",
        outcome: "changes_requested",
      });
    });

    it("executor re-submits after changes → returns to same review stage", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "changes_requested",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: "changes_requested",
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Fixed edge cases",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageId: reviewStageId,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
      });
    });
  });

  describe("review-only policy (no approval stage)", () => {
    const policy = reviewOnlyPolicy();
    const reviewStageId = policy.stages[0].id;

    it("reviewer approval completes the policy", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        executionDecision: "approve",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "LGTM",
      });

      expect(result.patch.executionState).toMatchObject({
        status: "completed",
        completedStageIds: [reviewStageId],
        lastDecisionOutcome: "approved",
      });
      expect(result.decision).toMatchObject({
        stageType: "review",
        outcome: "approved",
      });
    });
  });

  describe("approval-only policy (no review stage)", () => {
    const policy = approvalOnlyPolicy();

    it("executor completion routes directly to approval", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeUserId).toBe(ctoUserId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "approval",
      });
    });
  });

  describe("access control", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("non-participant cannot advance the active stage", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: { assigneeUserId: boardUserId },
          actor: { agentId: coderAgentId },
          commentBody: "Trying to bypass review",
        }),
      ).toThrow("Only the active reviewer or approver can advance");
    });

    it("non-participant can still post non-advancing updates", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Just a note",
      });

      // No error — just no patch modifications
      expect(result.patch).toEqual({});
    });
  });

  describe("board operator override", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    function pendingReviewIssue() {
      return {
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null as string | null,
        executionPolicy: policy,
        executionState: {
          status: "pending" as const,
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review" as const,
          currentParticipant: { type: "agent" as const, agentId: qaAgentId },
          returnAssignee: { type: "agent" as const, agentId: coderAgentId },
          completedStageIds: [] as string[],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      };
    }

    it("board user (non-participant) can force-complete the ticket via done", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: pendingReviewIssue(),
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch.executionState).toMatchObject({
        status: "completed",
        currentStageId: null,
        currentParticipant: null,
      });
    });

    it("board user (non-participant) aborts the review when reassigning", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: pendingReviewIssue(),
        policy,
        requestedStatus: undefined,
        requestedAssigneePatch: { assigneeAgentId: coderAgentId },
        actor: { userId: boardUserId },
      });

      expect(result.patch.executionState).toBeNull();
      // Assignment is NOT workflow-controlled, so the normal board assign check still runs.
      expect(result.workflowControlledAssignment).toBeUndefined();
    });

    it("board user (non-participant) aborts the review when unassigning", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: pendingReviewIssue(),
        policy,
        requestedStatus: undefined,
        requestedAssigneePatch: { assigneeAgentId: null },
        actor: { userId: boardUserId },
      });

      expect(result.patch.executionState).toBeNull();
    });

    it("board user (non-participant) can cancel, clearing execution state", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: pendingReviewIssue(),
        policy,
        requestedStatus: "cancelled",
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch.executionState).toBeNull();
    });

    it("board user (non-participant) can block while preserving the pending stage", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: pendingReviewIssue(),
        policy,
        requestedStatus: "blocked",
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      // Pending stage kept so review resumes when the issue returns to in_review.
      expect(result.patch.executionState).toBeUndefined();
    });

    it("board user (non-participant) can move the ticket back to in_progress, aborting review", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: pendingReviewIssue(),
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch.executionState).toBeNull();
    });

    it("agent (non-participant) is still gated from advancing the stage", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: pendingReviewIssue(),
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { agentId: coderAgentId },
          commentBody: "Trying to bypass review",
        }),
      ).toThrow("Only the active reviewer or approver can advance");
    });
  });

  describe("comment requirements", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("approval without comment throws", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          executionDecision: "approve",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "",
        }),
      ).toThrow("requires a comment");
    });

    it("changes requested without comment throws", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "in_progress",
          executionDecision: "request_changes",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: null,
        }),
      ).toThrow("requires a comment");
    });

    it("whitespace-only comment is treated as empty", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          executionDecision: "approve",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "   ",
        }),
      ).toThrow("requires a comment");
    });
  });

  describe("board reviewer status dispositions", () => {
    const policy = makePolicy([
      { type: "review", participants: [{ type: "user", userId: boardUserId }] },
    ]);
    const reviewStageId = policy.stages[0].id;

    function pendingUserReviewIssue() {
      return {
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: boardUserId,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "user", userId: boardUserId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      };
    }

    it("user reviewer cancels without a comment → workflow cleared, status honored", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: pendingUserReviewIssue(),
        policy,
        requestedStatus: "cancelled",
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
        commentBody: null,
      });

      expect(result.patch.executionState).toBeNull();
      expect(result.patch.status).toBeUndefined();
      expect(result.decision).toBeUndefined();
    });

    it("user reviewer blocks without a comment → pending stage kept, status honored", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: pendingUserReviewIssue(),
        policy,
        requestedStatus: "blocked",
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
        commentBody: null,
      });

      expect(result.patch.executionState).toBeUndefined();
      expect(result.patch.status).toBeUndefined();
      expect(result.decision).toBeUndefined();
    });

    // ACME-484: a board reviewer marked a ticket done from the UI and Paperclip
    // silently recorded it as the stage approval. Signing off a gate must be an
    // explicit act, never a side effect of changing the status.
    it("user reviewer cannot sign off with a bare status change to done", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: pendingUserReviewIssue(),
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { userId: boardUserId },
          commentBody: null,
        }),
      ).toThrow("requires the Approve action");
    });

    it("user reviewer cannot sign off by commenting while marking done", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: pendingUserReviewIssue(),
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { userId: boardUserId },
          commentBody: "looks fine",
        }),
      ).toThrow("requires the Approve action");
    });

    it("user reviewer approving explicitly still needs a comment for the decision trail", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: pendingUserReviewIssue(),
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { userId: boardUserId },
          commentBody: null,
          executionDecision: "approve",
        }),
      ).toThrow("requires a comment");
    });

    it("user reviewer approves via the explicit decision → stage completes with a decision record", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: pendingUserReviewIssue(),
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
        commentBody: "Verified in the Electron app",
        executionDecision: "approve",
      });

      expect(result.decision).toMatchObject({
        stageId: reviewStageId,
        stageType: "review",
        outcome: "approved",
        body: "Verified in the Electron app",
      });
      const state = result.patch.executionState as IssueExecutionState;
      expect(state.status).toBe("completed");
      expect(state.lastDecisionOutcome).toBe("approved");
      expect(state.completedStageIds).toContain(reviewStageId);
    });

    it("user reviewer approves to done with a comment → decision record kept", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: pendingUserReviewIssue(),
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
        commentBody: "LGTM",
        executionDecision: "approve",
      });

      expect(result.decision).toMatchObject({
        stageId: reviewStageId,
        stageType: "review",
        outcome: "approved",
        body: "LGTM",
      });
    });

    // Reviewers cannot cancel mid-stage by design: cancellation is a board action.
    it("agent reviewer setting a bare cancelled status is refused (needs executionDecision)", () => {
      const agentPolicy = twoStagePolicy();
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: agentPolicy,
            executionState: {
              status: "pending",
              currentStageId: agentPolicy.stages[0].id,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy: agentPolicy,
          requestedStatus: "cancelled",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: null,
        }),
      ).toThrow(expect.objectContaining({ status: 422, details: { code: "execution_decision_required" } }));
    });
  });

  describe("policy removal mid-flow", () => {
    it("clears execution state when policy removed and returns to executor", () => {
      // Use a real UUID for currentStageId so parseIssueExecutionState succeeds
      const stageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: {
            status: "pending",
            currentStageId: stageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: null,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
      });

      expect(result.patch.executionState).toBeNull();
      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
    });

    it("clears execution state without assignee change when not in_review", () => {
      const stageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: {
            status: "changes_requested",
            currentStageId: stageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: "changes_requested",
          },
        },
        policy: null,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch.executionState).toBeNull();
      // Not in_review, so no status/assignee change
      expect(result.patch.status).toBeUndefined();
    });
  });

  describe("reopening from done/cancelled clears state", () => {
    it("reopening a done issue clears execution state", () => {
      const policy = twoStagePolicy();
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "done",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "completed",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [policy.stages[0].id, policy.stages[1].id],
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
          },
        },
        policy,
        requestedStatus: "todo",
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch.executionState).toBeNull();
    });
  });

  describe("no-op transitions", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("non-done status change without review context is a no-op", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "blocked",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toEqual({});
    });

    it("coerces a malformed executor in_review patch into the first policy stage", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "in_review",
        requestedAssigneePatch: { assigneeUserId: boardUserId },
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
        },
      });
    });

    it("reasserts the active stage when issue status drifted out of in_review", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: { assigneeAgentId: coderAgentId },
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
        },
      });
    });

    it("no policy and no state is a no-op", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: null,
        },
        policy: null,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toEqual({});
    });

    it("does not auto-start workflow when policy is added to an already in_review issue", () => {
      const reviewOnly = reviewOnlyPolicy();
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: boardUserId,
          executionPolicy: null,
          executionState: null,
        },
        policy: reviewOnly,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch).toEqual({});
    });
  });

  describe("multi-participant stages", () => {
    it("selects the preferred participant when explicitly requested", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: { assigneeAgentId: ctoAgentId },
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
      });

      expect(result.patch.assigneeAgentId).toBe(ctoAgentId);
    });

    it("falls back to first participant when no preference given", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
      });

      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
    });

    it("excludes the return assignee from participant selection", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: coderAgentId },
            { type: "agent", agentId: qaAgentId },
          ],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      // coderAgentId is the returnAssignee, so QA should be selected
      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
    });

    it("skips a self-review-only stage and completes the workflow", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: coderAgentId }],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch).toMatchObject({
        executionState: {
          status: "completed",
          currentStageType: null,
          currentParticipant: null,
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [policy.stages[0].id],
        },
      });
      expect(result.patch.status).toBeUndefined();
      expect(result.patch.assigneeAgentId).toBeUndefined();
    });

    it("skips a self-review-only review stage and advances to approval", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: coderAgentId }],
        },
        {
          type: "approval",
          participants: [{ type: "user", userId: ctoUserId }],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: ctoUserId,
        executionState: {
          status: "pending",
          currentStageType: "approval",
          currentParticipant: { type: "user", userId: ctoUserId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [policy.stages[0].id],
        },
      });
    });
  });

  describe("changes requested with no return assignee", () => {
    it("throws when requesting changes with no return assignee", () => {
      const policy = twoStagePolicy();
      const reviewStageId = policy.stages[0].id;
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "in_progress",
          executionDecision: "request_changes",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "Changes needed",
        }),
      ).toThrow("no return assignee");
    });
  });

  describe("approval stage changes requested → bounces back to executor", () => {
    it("approver requests changes during approval stage", () => {
      const policy = twoStagePolicy();
      const reviewStageId = policy.stages[0].id;
      const approvalStageId = policy.stages[1].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: ctoUserId,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: approvalStageId,
            currentStageIndex: 1,
            currentStageType: "approval",
            currentParticipant: { type: "user", userId: ctoUserId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [reviewStageId],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { userId: ctoUserId },
        commentBody: "Not happy with the approach, needs rework",
      });

      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "changes_requested",
        currentStageType: "approval",
        lastDecisionOutcome: "changes_requested",
      });
      expect(result.decision).toMatchObject({
        stageId: approvalStageId,
        stageType: "approval",
        outcome: "changes_requested",
      });
    });
  });

  describe("user participants", () => {
    it("handles user-type reviewer participant correctly", () => {
      const policy = makePolicy([
        { type: "review", participants: [{ type: "user", userId: boardUserId }] },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBeNull();
      expect(result.patch.assigneeUserId).toBe(boardUserId);
    });
  });

  describe("policy edits while a stage is active", () => {
    it("clears the active execution state when its stage is removed from the policy", () => {
      const reviewAndApproval = twoStagePolicy();
      const approvalOnly = approvalOnlyPolicy();

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: reviewAndApproval,
          executionState: {
            status: "pending",
            currentStageId: reviewAndApproval.stages[0].id,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: approvalOnly,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch).toMatchObject({
        status: "in_progress",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionState: null,
      });
    });

    it("reassigns the active stage when the current participant is removed", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ]);
      const updatedPolicy = makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: ctoAgentId }],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: policy.stages[0].id,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: {
          ...updatedPolicy,
          stages: [{ ...updatedPolicy.stages[0], id: policy.stages[0].id }],
        },
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: ctoAgentId,
        assigneeUserId: null,
        executionState: {
          status: "pending",
          currentStageId: policy.stages[0].id,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: ctoAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
        },
      });
    });
  });

  describe("monitor policy", () => {
    it("schedules a one-shot monitor on an active agent-owned issue", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      })!;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: null,
          monitorAttemptCount: 0,
          monitorNextCheckAt: null,
          monitorLastTriggeredAt: null,
          monitorNotes: null,
          monitorScheduledBy: null,
        },
        policy,
        previousPolicy: null,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
        monitorExplicitlyUpdated: true,
      });

      expect(result.patch.monitorNextCheckAt).toEqual(new Date("2026-04-11T12:30:00.000Z"));
      expect(result.patch.monitorScheduledBy).toBe("board");
      expect(result.patch.executionState).toMatchObject({
        status: "idle",
        monitor: {
          status: "scheduled",
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      });
    });

    it("auto-clears a scheduled monitor when the issue moves to done", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "assignee",
        },
      })!;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "idle",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: null,
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
            monitor: {
              status: "scheduled",
              nextCheckAt: "2026-04-11T12:30:00.000Z",
              lastTriggeredAt: null,
              attemptCount: 0,
              notes: "Check deployment",
              scheduledBy: "assignee",
              clearedAt: null,
              clearReason: null,
            },
          },
          monitorAttemptCount: 0,
          monitorNextCheckAt: new Date("2026-04-11T12:30:00.000Z"),
          monitorLastTriggeredAt: null,
          monitorNotes: "Check deployment",
          monitorScheduledBy: "assignee",
        },
        policy,
        previousPolicy: policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch.executionPolicy).toBeNull();
      expect(result.patch.monitorNextCheckAt).toBeNull();
      expect(result.patch.executionState).toMatchObject({
        monitor: {
          status: "cleared",
          clearReason: "done",
        },
      });
    });

    it("rejects explicitly scheduling a monitor on an invalid issue state", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
        },
      })!;

      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "blocked",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            executionPolicy: null,
            executionState: null,
          },
          policy,
          previousPolicy: null,
          requestedAssigneePatch: {},
          actor: { agentId: coderAgentId },
          monitorExplicitlyUpdated: true,
        }),
      ).toThrow("Monitor can only be scheduled");
    });

    it("rejects explicitly re-arming a monitor after max attempts are exhausted", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2099-04-11T12:30:00.000Z",
          maxAttempts: 1,
          scheduledBy: "assignee",
        },
      })!;

      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            executionPolicy: null,
            executionState: null,
            monitorAttemptCount: 1,
            monitorNextCheckAt: null,
            monitorLastTriggeredAt: null,
            monitorNotes: null,
            monitorScheduledBy: "assignee",
          },
          policy,
          previousPolicy: null,
          requestedAssigneePatch: {},
          actor: { agentId: coderAgentId },
          monitorExplicitlyUpdated: true,
        }),
      ).toThrow("Monitor bounds are already exhausted");
    });
  });
});

describe("hold verb and held state", () => {
  const policy = twoStagePolicy();
  const reviewStageId = policy.stages[0].id;
  const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const pendingReviewState = {
    status: "pending" as const,
    currentStageId: reviewStageId,
    currentStageIndex: 0,
    currentStageType: "review" as const,
    currentParticipant: { type: "agent" as const, agentId: qaAgentId, userId: null },
    returnAssignee: { type: "agent" as const, agentId: coderAgentId, userId: null },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
  };
  const pendingIssue = () => ({
    status: "in_review",
    assigneeAgentId: qaAgentId,
    assigneeUserId: null,
    executionPolicy: policy,
    executionState: pendingReviewState,
  });
  const heldIssue = (resumeAt: string | null) => ({
    status: "in_review",
    assigneeAgentId: resumeAt ? qaAgentId : null,
    assigneeUserId: resumeAt ? null : boardUserId,
    executionPolicy: policy,
    executionState: {
      ...pendingReviewState,
      status: "held" as const,
      lastDecisionOutcome: "held" as const,
      hold: { reason: "Waiting on CI", resumeAt, heldBy: "participant" as const },
    },
  });
  const holdCall = (extra: Record<string, unknown>) =>
    applyIssueExecutionPolicyTransition({
      issue: pendingIssue(),
      policy,
      requestedAssigneePatch: {},
      actor: { agentId: qaAgentId },
      commentBody: "Waiting on CI",
      executionDecision: "hold",
      ...extra,
    } as Parameters<typeof applyIssueExecutionPolicyTransition>[0]);
  const expect422 = (fn: () => unknown, code: string) => {
    try {
      fn();
      expect.unreachable("expected a 422");
    } catch (err) {
      expect(err).toMatchObject({ status: 422, details: { code } });
    }
  };

  it("a timed hold keeps the stage, participant and assignee and records a held decision", () => {
    const resumeAt = future();
    const result = holdCall({ holdResumeAt: resumeAt });
    expect(result.patch.executionState).toMatchObject({
      status: "held",
      currentStageId: reviewStageId,
      currentParticipant: { type: "agent", agentId: qaAgentId },
      lastDecisionOutcome: "held",
      hold: { reason: "Waiting on CI", resumeAt, heldBy: "participant" },
    });
    expect(result.patch.assigneeAgentId).toBeUndefined();
    expect(result.patch.assigneeUserId).toBeUndefined();
    expect(result.patch.status).toBeUndefined();
    expect(result.decision).toEqual({
      stageId: reviewStageId,
      stageType: "review",
      outcome: "held",
      body: "Waiting on CI",
    });
  });

  it("hold paired with status in_review is accepted", () => {
    const result = holdCall({ holdResumeAt: future(), requestedStatus: "in_review" });
    expect(result.patch.executionState).toMatchObject({ status: "held" });
  });

  it.each(["done", "in_progress", "blocked"])("hold with status %s is a mismatch", (status) => {
    expect422(() => holdCall({ requestedStatus: status }), "execution_decision_status_mismatch");
  });

  it("a hold needs a reason", () => {
    expect422(() => holdCall({ commentBody: "  " , holdResumeAt: future() }), "execution_hold_reason_required");
  });

  it("a timed hold needs a resume time in the future", () => {
    expect422(
      () => holdCall({ holdResumeAt: new Date(Date.now() - 1000).toISOString() }),
      "execution_hold_resume_invalid",
    );
  });

  it("an untimed hold assigns the issue to the operator and strips the comment prefix from the reason", () => {
    const result = holdCall({
      holdOperatorUserId: boardUserId,
      commentBody: "Operator action needed: staging is down",
    });
    expect(result.patch).toMatchObject({ assigneeAgentId: null, assigneeUserId: boardUserId });
    expect(result.workflowControlledAssignment).toBe(true);
    expect(result.patch.executionState).toMatchObject({
      status: "held",
      currentParticipant: { type: "agent", agentId: qaAgentId },
      hold: { reason: "staging is down", resumeAt: null, heldBy: "participant" },
    });
    expect(result.decision).toMatchObject({ outcome: "held", body: "staging is down" });
  });

  it("an untimed hold with no operator to hand to is refused", () => {
    expect422(() => holdCall({ holdOperatorUserId: null }), "execution_hold_no_operator");
  });

  it("only the active participant can hold", () => {
    expect(() => holdCall({ actor: { agentId: coderAgentId }, holdResumeAt: future() })).toThrow(
      /Only the active reviewer or approver/,
    );
  });

  it("any agent PATCH on a held issue is refused with execution_held", () => {
    for (const agentId of [qaAgentId, coderAgentId]) {
      expect422(
        () =>
          applyIssueExecutionPolicyTransition({
            issue: heldIssue(future()),
            policy,
            requestedAssigneePatch: {},
            actor: { agentId },
            commentBody: "Done",
            executionDecision: "approve",
          }),
        "execution_held",
      );
    }
  });

  it("a board PATCH status in_review resumes the same stage with the same participant", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: heldIssue(null),
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { userId: boardUserId },
    });
    expect(result.patch).toMatchObject({ status: "in_review", assigneeAgentId: qaAgentId, assigneeUserId: null });
    expect(result.workflowControlledAssignment).toBe(true);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentStageId: reviewStageId,
      currentParticipant: { type: "agent", agentId: qaAgentId },
      hold: null,
    });
    expect(result.decision).toBeUndefined();
  });

  it("the board's done override still completes a held workflow and cancelled clears it", () => {
    const done = applyIssueExecutionPolicyTransition({
      issue: heldIssue(null),
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { userId: boardUserId },
    });
    expect(done.patch.executionState).toMatchObject({ status: "completed", hold: null });
    const cancelled = applyIssueExecutionPolicyTransition({
      issue: heldIssue(null),
      policy,
      requestedStatus: "cancelled",
      requestedAssigneePatch: {},
      actor: { userId: boardUserId },
    });
    expect(cancelled.patch.executionState).toBeNull();
  });

  it("a board PATCH with no status leaves the hold in place", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: heldIssue(null),
      policy,
      requestedAssigneePatch: {},
      actor: { userId: boardUserId },
      commentBody: "Looking into it",
    });
    expect(result.patch.executionState).toBeUndefined();
  });

  it("resumeHeldExecutionState returns to pending at the same stage", () => {
    const resumed = resumeHeldExecutionState(parseIssueExecutionState(heldIssue(future()).executionState)!);
    expect(resumed).toMatchObject({
      status: "pending",
      currentStageId: reviewStageId,
      currentParticipant: { type: "agent", agentId: qaAgentId },
      hold: null,
    });
  });
});
