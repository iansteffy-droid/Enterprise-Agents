import { describe, expect, it } from "vitest";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import {
  assertExecutionPolicyLevelInvariants,
  assertNoSelfParticipant,
} from "../services/execution-policy-invariants.js";

const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function policy(stages: IssueExecutionPolicy["stages"]): IssueExecutionPolicy {
  return { mode: "normal", commentRequired: true, stages };
}

const agentReview = (agentId: string): IssueExecutionPolicy["stages"][number] => ({
  id: "s-review",
  type: "review",
  approvalsNeeded: 1,
  participants: [{ id: "p1", type: "agent", agentId, userId: null }],
});
const userApproval = (): IssueExecutionPolicy["stages"][number] => ({
  id: "s-approval",
  type: "approval",
  approvalsNeeded: 1,
  participants: [{ id: "p2", type: "user", agentId: null, userId: "board-user" }],
});

describe("assertExecutionPolicyLevelInvariants", () => {
  it("accepts top-level policy ending in a user approval stage", () => {
    expect(() =>
      assertExecutionPolicyLevelInvariants(policy([agentReview(AGENT_A), userApproval()]), "top_level"),
    ).not.toThrow();
  });

  it("rejects top-level policy whose last stage is an agent review", () => {
    expect(() =>
      assertExecutionPolicyLevelInvariants(policy([agentReview(AGENT_A)]), "top_level"),
    ).toThrowError(expect.objectContaining({ status: 422, details: { code: "execution_policy_level_invariant" } }));
  });

  it("rejects top-level policy whose approval stage mixes agent and user", () => {
    const mixed = userApproval();
    mixed.participants.push({ id: "p3", type: "agent", agentId: AGENT_A, userId: null });
    expect(() => assertExecutionPolicyLevelInvariants(policy([mixed]), "top_level")).toThrowError(
      expect.objectContaining({ status: 422, details: { code: "execution_policy_level_invariant" } }),
    );
  });

  it("rejects subtask policy containing a user participant anywhere", () => {
    expect(() =>
      assertExecutionPolicyLevelInvariants(policy([agentReview(AGENT_A), userApproval()]), "subtask"),
    ).toThrowError(expect.objectContaining({ status: 422, details: { code: "execution_policy_level_invariant" } }));
    expect(() =>
      assertExecutionPolicyLevelInvariants(policy([agentReview(AGENT_A), agentReview(AGENT_B)]), "subtask"),
    ).not.toThrow();
  });

  it("rejects an empty stage list for both levels", () => {
    for (const level of ["top_level", "subtask"] as const) {
      expect(() => assertExecutionPolicyLevelInvariants(policy([]), level)).toThrowError(
        expect.objectContaining({ status: 422, details: { code: "execution_policy_level_invariant" } }),
      );
    }
  });
});

describe("assertNoSelfParticipant", () => {
  it("rejects a chain that names the saving agent and allows others", () => {
    expect(() => assertNoSelfParticipant(policy([agentReview(AGENT_A)]), AGENT_A)).toThrowError(
      expect.objectContaining({ status: 422, details: { code: "execution_policy_self_participant" } }),
    );
    expect(() => assertNoSelfParticipant(policy([agentReview(AGENT_A)]), AGENT_B)).not.toThrow();
  });
});
