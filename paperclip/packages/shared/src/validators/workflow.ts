import { z } from "zod";
import { issueExecutionStageSchema } from "./issue.js";

export const DEFAULT_WORKFLOW_HALT_PHRASES = [
  "done",
  "merged",
  "done and merged",
  "cancel",
  "cancelled",
  "stop",
  "halt",
] as const;

export const DEFAULT_WORKFLOW_GATED_SUBTASK_KINDS = ["impl", "tests"] as const;

export const DEFAULT_WORKFLOW_RETRO = {
  routineId: null,
  autoTrigger: false,
  bounceThreshold: 2,
  cooldownHours: 24,
} as const;

const stageTemplatesSchema = z.array(issueExecutionStageSchema);

/**
 * Chain, halt, intake, gating and retro settings stored on the per-company
 * workflow_blueprints row. Every field is optional on input: absent means "keep the
 * stored value", null clears it. Defaults are applied only inside `retro` once the
 * object is supplied; the chains themselves are validated further by the server.
 */
export const workflowBlueprintDefaultsSchema = z.object({
  mode: z.string().trim().min(1).max(64).optional(),
  subtaskStages: stageTemplatesSchema.nullable().optional(),
  featureStages: stageTemplatesSchema.nullable().optional(),
  haltPhrases: z.array(z.string().trim().min(1).max(100)).max(50).nullable().optional(),
  intakeAgentId: z.string().uuid().nullable().optional(),
  gatedSubtaskKinds: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  retro: z
    .object({
      routineId: z.string().uuid().nullable().default(DEFAULT_WORKFLOW_RETRO.routineId),
      autoTrigger: z.boolean().default(DEFAULT_WORKFLOW_RETRO.autoTrigger),
      bounceThreshold: z.number().int().min(1).max(100).default(DEFAULT_WORKFLOW_RETRO.bounceThreshold),
      cooldownHours: z.number().int().min(0).max(24 * 365).default(DEFAULT_WORKFLOW_RETRO.cooldownHours),
    })
    .nullable()
    .optional(),
  prepareForMergeRoutineId: z.string().uuid().nullable().optional(),
});

export type WorkflowBlueprintDefaultsInput = z.infer<typeof workflowBlueprintDefaultsSchema>;
