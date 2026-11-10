import { and, eq, inArray } from "drizzle-orm";
import { agents, routines, workflowBlueprints } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type {
  IssueExecutionPolicy,
  WorkflowRetroSettings,
  WorkflowStageTemplate,
  WorkflowBlueprint,
  WorkflowBlueprintReturnEdge,
  WorkflowBlueprintStage,
} from "@paperclipai/shared";

import { HttpError } from "../errors.js";
import { DIRECT_NON_INVOKABLE_STATUSES } from "./agent-invokability.js";
import {
  assertExecutionPolicyLevelInvariants,
  assertNoSelfParticipant,
  type ExecutionPolicyLevel,
} from "./execution-policy-invariants.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";

export class WorkflowBlueprintValidationError extends Error {
  status = 422 as const;
  code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "WorkflowBlueprintValidationError";
    this.code = code;
  }
}

/** Wraps a chain template in a policy; commentRequired is always forced true. */
export function buildChainPolicy(stages: WorkflowStageTemplate[]): IssueExecutionPolicy {
  const normalized = normalizeIssueExecutionPolicy({ mode: "normal", commentRequired: true, stages });
  return normalized ?? { mode: "normal", commentRequired: true, stages: [] };
}

function stripIds(policy: IssueExecutionPolicy): WorkflowStageTemplate[] {
  return policy.stages.map((stage) => ({
    type: stage.type,
    approvalsNeeded: stage.approvalsNeeded,
    participants: stage.participants.map((p) => ({ type: p.type, agentId: p.agentId ?? null, userId: p.userId ?? null })),
  }));
}

function validateChain(
  stages: WorkflowStageTemplate[],
  level: ExecutionPolicyLevel,
  savingAgentId: string | null,
): IssueExecutionPolicy {
  try {
    const policy = buildChainPolicy(stages);
    assertExecutionPolicyLevelInvariants(policy, level);
    if (savingAgentId) assertNoSelfParticipant(policy, savingAgentId);
    return policy;
  } catch (err) {
    if (err instanceof HttpError && err.status === 422) {
      const code = (err.details as { code?: string } | undefined)?.code ?? "execution_policy_invalid";
      throw new WorkflowBlueprintValidationError(err.message, code);
    }
    throw err;
  }
}

export interface UpsertBlueprintInput {
  name?: string;
  stages: WorkflowBlueprintStage[];
  returnEdges: WorkflowBlueprintReturnEdge[];
  /** For the optional fields below, undefined keeps the stored value and null clears it. */
  mode?: string;
  subtaskStages?: WorkflowStageTemplate[] | null;
  featureStages?: WorkflowStageTemplate[] | null;
  haltPhrases?: string[] | null;
  intakeAgentId?: string | null;
  gatedSubtaskKinds?: string[];
  retro?: WorkflowRetroSettings | null;
  prepareForMergeRoutineId?: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
}

function toDto(row: {
  companyId: string;
  name: string;
  stages: WorkflowBlueprintStage[];
  returnEdges: WorkflowBlueprintReturnEdge[];
  mode: string;
  subtaskStages: WorkflowStageTemplate[] | null;
  featureStages: WorkflowStageTemplate[] | null;
  haltPhrases: string[] | null;
  intakeAgentId: string | null;
  gatedSubtaskKinds: string[];
  retro: WorkflowRetroSettings | null;
  prepareForMergeRoutineId: string | null;
  updatedAt: Date | null;
}): WorkflowBlueprint {
  return {
    companyId: row.companyId,
    name: row.name,
    stages: [...row.stages].sort((a, b) => a.position - b.position),
    returnEdges: row.returnEdges,
    mode: row.mode,
    subtaskStages: row.subtaskStages,
    featureStages: row.featureStages,
    haltPhrases: row.haltPhrases,
    intakeAgentId: row.intakeAgentId,
    gatedSubtaskKinds: row.gatedSubtaskKinds,
    retro: row.retro,
    prepareForMergeRoutineId: row.prepareForMergeRoutineId,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

export function workflowBlueprintService(db: Db) {
  return {
    async validateAgentIds(companyId: string, agentIds: string[]): Promise<string[]> {
      const unique = [...new Set(agentIds)];
      if (unique.length === 0) return [];
      const rows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, unique)));
      const known = new Set(rows.map((r) => r.id));
      return unique.filter((id) => !known.has(id));
    },

    async validateRoutineIds(companyId: string, routineIds: string[]): Promise<string[]> {
      const unique = [...new Set(routineIds)];
      if (unique.length === 0) return [];
      const rows = await db
        .select({ id: routines.id })
        .from(routines)
        .where(and(eq(routines.companyId, companyId), inArray(routines.id, unique)));
      const known = new Set(rows.map((r) => r.id));
      return unique.filter((id) => !known.has(id));
    },

    async get(companyId: string): Promise<WorkflowBlueprint | null> {
      const [row] = await db
        .select()
        .from(workflowBlueprints)
        .where(eq(workflowBlueprints.companyId, companyId))
        .limit(1);
      return row ? toDto(row) : null;
    },

    async upsert(companyId: string, input: UpsertBlueprintInput): Promise<WorkflowBlueprint> {
      const allAgentIds = input.stages
        .flatMap((s) => s.agentIds)
        .concat(input.returnEdges.flatMap((e) => [e.fromAgentId, e.toAgentId]));
      const unknown = await this.validateAgentIds(companyId, allAgentIds);
      if (unknown.length > 0) {
        throw new WorkflowBlueprintValidationError(
          `blueprint references agents not in company: ${unknown.join(", ")}`,
        );
      }

      // What is validated is what is stored: the cleaned templates, without minted ids.
      const subtaskPolicy = input.subtaskStages ? validateChain(input.subtaskStages, "subtask", input.createdByAgentId) : null;
      const featurePolicy = input.featureStages ? validateChain(input.featureStages, "top_level", input.createdByAgentId) : null;
      const chainPolicies: IssueExecutionPolicy[] = [subtaskPolicy, featurePolicy].filter(
        (p): p is IssueExecutionPolicy => p !== null,
      );
      const chainAgentIds = chainPolicies.flatMap((policy) =>
        policy.stages.flatMap((stage) => stage.participants.flatMap((p) => (p.agentId ? [p.agentId] : []))),
      );
      const unknownChainAgents = await this.validateAgentIds(
        companyId,
        [...chainAgentIds, ...(input.intakeAgentId ? [input.intakeAgentId] : [])],
      );
      if (unknownChainAgents.length > 0) {
        throw new WorkflowBlueprintValidationError(
          `blueprint references agents not in company: ${unknownChainAgents.join(", ")}`,
          "workflow_agent_not_in_company",
        );
      }
      if (chainAgentIds.length > 0) {
        const statusRows = await db
          .select({ id: agents.id, status: agents.status })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, [...new Set(chainAgentIds)])));
        const blocked = statusRows.filter((r) => DIRECT_NON_INVOKABLE_STATUSES.has(r.status));
        if (blocked.length > 0) {
          throw new WorkflowBlueprintValidationError(
            `execution policy names agents that cannot be invoked: ${blocked.map((r) => `${r.id} (${r.status})`).join(", ")}`,
            "execution_policy_participant_not_invokable",
          );
        }
      }
      const routineIds = [input.retro?.routineId, input.prepareForMergeRoutineId].filter(
        (id): id is string => typeof id === "string",
      );
      const unknownRoutines = await this.validateRoutineIds(companyId, routineIds);
      if (unknownRoutines.length > 0) {
        throw new WorkflowBlueprintValidationError(
          `blueprint references routines not in company: ${unknownRoutines.join(", ")}`,
          "workflow_routine_not_in_company",
        );
      }

      // Optional settings: undefined = leave the stored value alone (or the column default on insert).
      const optional = {
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.subtaskStages !== undefined
          ? { subtaskStages: subtaskPolicy ? stripIds(subtaskPolicy) : null }
          : {}),
        ...(input.featureStages !== undefined
          ? { featureStages: featurePolicy ? stripIds(featurePolicy) : null }
          : {}),
        ...(input.haltPhrases !== undefined ? { haltPhrases: input.haltPhrases } : {}),
        ...(input.intakeAgentId !== undefined ? { intakeAgentId: input.intakeAgentId } : {}),
        ...(input.gatedSubtaskKinds !== undefined ? { gatedSubtaskKinds: input.gatedSubtaskKinds } : {}),
        ...(input.retro !== undefined ? { retro: input.retro } : {}),
        ...(input.prepareForMergeRoutineId !== undefined
          ? { prepareForMergeRoutineId: input.prepareForMergeRoutineId }
          : {}),
      };
      const values = {
        ...optional,
        companyId,
        name: input.name ?? "Ticket Lifecycle",
        stages: input.stages,
        returnEdges: input.returnEdges,
        createdByUserId: input.createdByUserId,
        createdByAgentId: input.createdByAgentId,
        updatedAt: new Date(),
      };
      const [row] = await db
        .insert(workflowBlueprints)
        .values(values)
        .onConflictDoUpdate({
          target: workflowBlueprints.companyId,
          set: {
            name: values.name,
            stages: values.stages,
            returnEdges: values.returnEdges,
            ...optional,
            updatedAt: values.updatedAt,
          },
        })
        .returning();
      return toDto(row);
    },
  };
}
