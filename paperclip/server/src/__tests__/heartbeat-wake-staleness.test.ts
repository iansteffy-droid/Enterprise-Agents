import { describe, expect, it } from "vitest";
import {
  evaluateIssueWakeStalenessFromSnapshot,
  isExecutionOwnershipWakeReason,
} from "../services/heartbeat.ts";

// ---------------------------------------------------------------------------
// evaluateIssueWakeStalenessFromSnapshot — the pure predicate shared by the
// start-time gate and the deferred-wake promotion path.
//
// Root cause it guards: a review wake for
// agent X is deferred behind X's currently-running run. By the time the run
// finishes and the wake is promoted, X has already done the review and handed
// the issue off, so the promoted run would be created only to be cancelled at
// start with `issue_assignee_changed`. Checking staleness at promotion time
// means the phantom run is never created in the first place.
// ---------------------------------------------------------------------------

// Execution-state principals are validated as UUIDs by the shared schema,
// so participant fixtures must use real UUIDs to parse.
const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const STAGE_ID = "aabd75c6-7fb5-464a-80c0-bbcf99178ef3";

describe("evaluateIssueWakeStalenessFromSnapshot", () => {
  it("is fresh when the agent still owns an in_progress issue", () => {
    const result = evaluateIssueWakeStalenessFromSnapshot({
      issue: { status: "in_progress", assigneeAgentId: AGENT, executionState: null },
      agentId: AGENT,
      context: { wakeReason: "execution_review_requested" },
    });
    expect(result.stale).toBe(false);
  });

  it("is stale when the issue assignee changed (the ACME-162 phantom)", () => {
    const result = evaluateIssueWakeStalenessFromSnapshot({
      issue: { status: "in_progress", assigneeAgentId: OTHER, executionState: null },
      agentId: AGENT,
      context: { wakeReason: "execution_review_requested" },
    });
    expect(result.stale).toBe(true);
    expect(result.stale && result.errorCode).toBe("issue_assignee_changed");
  });

  it("does NOT treat an assignee change as stale for an interaction/comment wake", () => {
    // A comment/mention wake can legitimately target a non-assignee.
    const result = evaluateIssueWakeStalenessFromSnapshot({
      issue: { status: "in_progress", assigneeAgentId: OTHER, executionState: null },
      agentId: AGENT,
      context: { wakeReason: "issue_commented", commentId: "comment-1" },
    });
    expect(result.stale).toBe(false);
  });

  it("is stale when the issue reached a terminal status", () => {
    const result = evaluateIssueWakeStalenessFromSnapshot({
      issue: { status: "done", assigneeAgentId: AGENT, executionState: null },
      agentId: AGENT,
      context: { wakeReason: "execution_review_requested" },
    });
    expect(result.stale).toBe(true);
    expect(result.stale && result.errorCode).toBe("issue_terminal_status");
  });

  it("does NOT treat terminal status as stale when a comment wake wants to reopen", () => {
    const result = evaluateIssueWakeStalenessFromSnapshot({
      issue: { status: "done", assigneeAgentId: AGENT, executionState: null },
      agentId: AGENT,
      context: { wakeReason: "issue_commented", commentId: "comment-1" },
    });
    expect(result.stale).toBe(false);
  });

  it("is stale when the in_review participant changed to another agent", () => {
    const executionState = {
      status: "pending",
      monitor: null,
      reviewRequest: null,
      currentStageId: STAGE_ID,
      lastDecisionId: null,
      returnAssignee: { type: "agent", userId: null, agentId: AGENT },
      currentStageType: "review",
      completedStageIds: [],
      currentStageIndex: 0,
      currentParticipant: { type: "agent", userId: null, agentId: OTHER },
      lastDecisionOutcome: null,
    };
    const result = evaluateIssueWakeStalenessFromSnapshot({
      // assignee still points at the wake target so we isolate the participant check
      issue: { status: "in_review", assigneeAgentId: AGENT, executionState },
      agentId: AGENT,
      context: { wakeReason: "execution_review_requested" },
    });
    expect(result.stale).toBe(true);
    expect(result.stale && result.errorCode).toBe("issue_review_participant_changed");
  });

  it("is fresh when the in_review participant still matches the wake target", () => {
    const executionState = {
      status: "pending",
      monitor: null,
      reviewRequest: null,
      currentStageId: STAGE_ID,
      lastDecisionId: null,
      returnAssignee: { type: "agent", userId: null, agentId: OTHER },
      currentStageType: "review",
      completedStageIds: [],
      currentStageIndex: 0,
      currentParticipant: { type: "agent", userId: null, agentId: AGENT },
      lastDecisionOutcome: null,
    };
    const result = evaluateIssueWakeStalenessFromSnapshot({
      issue: { status: "in_review", assigneeAgentId: AGENT, executionState },
      agentId: AGENT,
      context: { wakeReason: "execution_review_requested" },
    });
    expect(result.stale).toBe(false);
  });

  it("is stale when the issue's dependencies are still blocked", () => {
    const result = evaluateIssueWakeStalenessFromSnapshot({
      issue: { status: "blocked", assigneeAgentId: AGENT, executionState: null },
      agentId: AGENT,
      context: { wakeReason: "execution_changes_requested" },
      dependency: { ready: false, unresolvedBlockerIssueIds: ["blocker-1"] },
    });
    expect(result.stale).toBe(true);
    expect(result.stale && result.errorCode).toBe("issue_dependencies_blocked");
  });

  it("is fresh when dependencies are ready", () => {
    const result = evaluateIssueWakeStalenessFromSnapshot({
      issue: { status: "in_progress", assigneeAgentId: AGENT, executionState: null },
      agentId: AGENT,
      context: { wakeReason: "execution_changes_requested" },
      dependency: { ready: true },
    });
    expect(result.stale).toBe(false);
  });

  it("does NOT block a comment/interaction wake even when dependencies are blocked", () => {
    // Blocked issues still allow bounded interaction wakes so the assignee can triage.
    const result = evaluateIssueWakeStalenessFromSnapshot({
      issue: { status: "blocked", assigneeAgentId: AGENT, executionState: null },
      agentId: AGENT,
      context: { wakeReason: "issue_commented", commentId: "comment-1" },
      dependency: { ready: false, unresolvedBlockerIssueIds: ["blocker-1"] },
    });
    expect(result.stale).toBe(false);
  });

  it("ignores dependency state when no dependency snapshot is passed (gate path)", () => {
    const result = evaluateIssueWakeStalenessFromSnapshot({
      issue: { status: "blocked", assigneeAgentId: AGENT, executionState: null },
      agentId: AGENT,
      context: { wakeReason: "execution_changes_requested" },
    });
    expect(result.stale).toBe(false);
  });
});

describe("isExecutionOwnershipWakeReason", () => {
  it("recognises ownership wake reasons (subject to the assignee-changed skip)", () => {
    for (const wakeReason of [
      "issue_assigned",
      "execution_review_requested",
      "execution_approval_requested",
      "execution_changes_requested",
      "issue_continuation_needed",
    ]) {
      expect(isExecutionOwnershipWakeReason({ wakeReason })).toBe(true);
    }
  });

  it("does NOT treat mention/comment/blocker wakes as ownership wakes", () => {
    // These legitimately target an agent who is not the current assignee, so
    // the promotion path must never drop them as issue_assignee_changed.
    for (const wakeReason of [
      "issue_mention",
      "issue_commented",
      "issue_comment_mentioned",
      "issue_blockers_resolved",
      "issue_monitor_due",
      "heartbeat_timer",
    ]) {
      expect(isExecutionOwnershipWakeReason({ wakeReason })).toBe(false);
    }
    expect(isExecutionOwnershipWakeReason(null)).toBe(false);
    expect(isExecutionOwnershipWakeReason({})).toBe(false);
  });
});
