import type { IssueExecutionPolicy } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

export type ExecutionPolicyLevel = "top_level" | "subtask";

function levelViolation(message: string) {
  return unprocessable(message, { code: "execution_policy_level_invariant" });
}

/**
 * Level rules for a default review chain: a top-level (feature) chain ends in exactly
 * one approval stage whose participants are all users; a subtask chain never asks a
 * user. Both need at least one stage.
 */
export function assertExecutionPolicyLevelInvariants(
  policy: IssueExecutionPolicy,
  level: ExecutionPolicyLevel,
): void {
  const stages = policy.stages;
  if (stages.length < 1) {
    throw levelViolation("Execution policy must have at least one stage");
  }
  if (level === "subtask") {
    const hasUser = stages.some((stage) => stage.participants.some((p) => p.type === "user"));
    if (hasUser) throw levelViolation("A subtask execution policy cannot have a user participant");
    return;
  }
  const last = stages[stages.length - 1]!;
  if (last.type !== "approval") {
    throw levelViolation("A top-level execution policy must end in an approval stage");
  }
  if (last.participants.length === 0 || last.participants.some((p) => p.type !== "user")) {
    throw levelViolation("The terminal approval stage of a top-level execution policy must have only user participants");
  }
  const approvalCount = stages.filter((stage) => stage.type === "approval").length;
  if (approvalCount !== 1) {
    throw levelViolation("A top-level execution policy must have exactly one approval stage");
  }
}

/** An agent may not save or attach a chain that names itself as a participant. */
export function assertNoSelfParticipant(policy: IssueExecutionPolicy, agentId: string): void {
  const names = policy.stages.some((stage) =>
    stage.participants.some((p) => p.type === "agent" && p.agentId === agentId),
  );
  if (names) {
    throw unprocessable("An agent cannot save an execution policy that names itself", {
      code: "execution_policy_self_participant",
    });
  }
}
