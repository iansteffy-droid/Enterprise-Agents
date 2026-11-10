import { and, eq, inArray } from "drizzle-orm";
import { issueExecutionDecisions, labels } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { IssueExecutionPolicy, WorkflowBlueprint } from "@paperclipai/shared";

import {
  assertExecutionPolicyLevelInvariants,
  assertNoSelfParticipant,
  type ExecutionPolicyLevel,
} from "./execution-policy-invariants.js";
import { buildChainPolicy, workflowBlueprintService } from "./workflow-blueprint.js";

export const ISSUE_KINDS = ["impl", "tests", "repro"] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

const KIND_LABEL_PREFIX = "kind:";
const DEFAULT_ISSUE_KIND: IssueKind = "impl";

/**
 * Reads the subtask kind from label names. Only the exact, case-sensitive labels
 * `kind:impl`, `kind:tests` and `kind:repro` count; a subtask without one is `impl`.
 */
export function issueKindsFromLabels(labelNames: readonly string[]): IssueKind[] {
  const kinds: IssueKind[] = [];
  for (const name of labelNames) {
    if (!name.startsWith(KIND_LABEL_PREFIX)) continue;
    const kind = name.slice(KIND_LABEL_PREFIX.length) as IssueKind;
    if ((ISSUE_KINDS as readonly string[]).includes(kind) && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds.length > 0 ? kinds : [DEFAULT_ISSUE_KIND];
}

/** A top-level issue leaves intake once it is assigned to an agent other than the intake agent. */
export function leavesIntake(assigneeAgentId: string | null | undefined, intakeAgentId: string | null): boolean {
  return Boolean(assigneeAgentId) && assigneeAgentId !== intakeAgentId;
}

export function issueLevel(parentId: string | null | undefined): ExecutionPolicyLevel {
  return parentId ? "subtask" : "top_level";
}

/** A policy is a chain when it has at least one stage (monitor-only policies are not). */
export function hasExecutionChain(policy: IssueExecutionPolicy | null | undefined): boolean {
  return Boolean(policy && policy.stages.length > 0);
}

export interface ResolvePolicyInput {
  companyId: string;
  parentId: string | null;
  /** Normalized body value; null when absent or null. */
  explicitPolicy: IssueExecutionPolicy | null;
  /** The body contained `"executionPolicy": null`. */
  explicitNull: boolean;
  assigneeAgentId: string | null;
  originKind: string | null | undefined;
  /** Names of the labels the issue will carry (kind labels decide subtask gating). */
  labelNames: readonly string[];
  actor: { type: "agent" | "user"; agentId: string | null };
  /** A board user ungated this issue earlier (issues.execution_policy_ungated_at); no default attaches. */
  ungated?: boolean;
}

export interface ResolvedIssuePolicy {
  policy: IssueExecutionPolicy | null;
  /** explicit = taken from the body; default = minted from the company blueprint. */
  source: "explicit" | "default" | "none";
  /** True when a top-level issue leaves intake under a company feature chain (sets left_intake_at). */
  leftIntake: boolean;
  /** A board user's explicit null: record it (execution_policy_ungated_at) so later steps honour it. */
  boardUngated: boolean;
}

const NONE: ResolvedIssuePolicy = { policy: null, source: "none", leftIntake: false, boardUngated: false };

/**
 * Resolution order (first match wins), applied only when the company has a blueprint row;
 * without one, an explicit policy is kept as-is and nothing else is attached:
 * 1. explicit policy: level invariants (when it has stages), and an agent may not name itself;
 * 2. a board user's explicit null, now or recorded earlier (`ungated`): ungated;
 * 3. routine_execution issues: ungated;
 * 4. subtask: the subtask chain when its kind label is gated (no kind label = impl);
 * 5. top-level: the feature chain once it leaves intake; nothing while in intake.
 * An agent's explicit null is ignored (falls through to 3–5).
 */
export function resolveIssueExecutionPolicyWithBlueprint(
  blueprint: WorkflowBlueprint | null,
  input: ResolvePolicyInput,
): ResolvedIssuePolicy {
  const level = issueLevel(input.parentId);
  if (!blueprint) {
    return input.explicitPolicy
      ? { policy: input.explicitPolicy, source: "explicit", leftIntake: false, boardUngated: false }
      : NONE;
  }
  const underFeatureChain =
    level === "top_level" &&
    blueprint.featureStages !== null &&
    leavesIntake(input.assigneeAgentId, blueprint.intakeAgentId);

  if (input.explicitPolicy) {
    assertExplicitExecutionPolicy(input.explicitPolicy, level, input.actor);
    return { policy: input.explicitPolicy, source: "explicit", leftIntake: underFeatureChain, boardUngated: false };
  }
  if (input.explicitNull && input.actor.type === "user") return { ...NONE, boardUngated: true };
  if (input.ungated) return NONE;
  if (input.originKind === "routine_execution") return NONE;

  if (level === "subtask") {
    if (!blueprint.subtaskStages) return NONE;
    const gated = issueKindsFromLabels(input.labelNames).some((kind) => blueprint.gatedSubtaskKinds.includes(kind));
    return gated
      ? { policy: buildChainPolicy(blueprint.subtaskStages), source: "default", leftIntake: false, boardUngated: false }
      : NONE;
  }
  if (!underFeatureChain || !blueprint.featureStages) return NONE;
  return { policy: buildChainPolicy(blueprint.featureStages), source: "default", leftIntake: true, boardUngated: false };
}

/** Level invariants for a policy with stages, plus "an agent may not name itself". */
export function assertExplicitExecutionPolicy(
  policy: IssueExecutionPolicy,
  level: ExecutionPolicyLevel,
  actor: { type: "agent" | "user"; agentId: string | null },
): void {
  if (hasExecutionChain(policy)) assertExecutionPolicyLevelInvariants(policy, level);
  if (actor.type === "agent" && actor.agentId) assertNoSelfParticipant(policy, actor.agentId);
}

export async function resolveIssueExecutionPolicy(db: Db, input: ResolvePolicyInput): Promise<ResolvedIssuePolicy> {
  const blueprint = await workflowBlueprintService(db).get(input.companyId);
  return resolveIssueExecutionPolicyWithBlueprint(blueprint, input);
}

/** Data access the issue routes need to resolve company default chains. */
export function issueDefaultPolicyService(db: Db) {
  return {
    getBlueprint: (companyId: string) => workflowBlueprintService(db).get(companyId),

    async labelNames(companyId: string, labelIds: readonly string[] | null | undefined): Promise<string[]> {
      const ids = [...new Set(labelIds ?? [])];
      if (ids.length === 0) return [];
      const rows = await db
        .select({ name: labels.name })
        .from(labels)
        .where(and(eq(labels.companyId, companyId), inArray(labels.id, ids)));
      return rows.map((row) => row.name);
    },

    async hasDecisions(companyId: string, issueId: string): Promise<boolean> {
      const rows = await db
        .select({ id: issueExecutionDecisions.id })
        .from(issueExecutionDecisions)
        .where(and(eq(issueExecutionDecisions.companyId, companyId), eq(issueExecutionDecisions.issueId, issueId)))
        .limit(1);
      return rows.length > 0;
    },
  };
}

/**
 * Swaps the review chain of `base` for `chain`, keeping the rest of the policy
 * (monitor, review preset, authorization policy). Returns null when nothing is left.
 */
export function replaceExecutionChain(
  base: IssueExecutionPolicy | null,
  chain: IssueExecutionPolicy | null,
): IssueExecutionPolicy | null {
  if (!base) return chain;
  if (chain) return { ...base, mode: chain.mode, commentRequired: true, stages: chain.stages };
  const rest: IssueExecutionPolicy = { ...base, stages: [] };
  return rest.monitor || rest.reviewPreset || rest.authorizationPolicy ? rest : null;
}
