import type { IssueExecutionStage, IssueExecutionStageParticipant } from "./issue.js";

export interface WorkflowBlueprintStage {
  key: string;
  label: string;
  position: number;
  agentIds: string[];
}

export interface WorkflowBlueprintReturnEdge {
  fromAgentId: string;
  toAgentId: string;
  label: string;
}

/** A review-chain stage template: an issue execution stage without minted ids. */
export type WorkflowStageTemplate = Omit<IssueExecutionStage, "id" | "participants"> & {
  id?: string;
  participants: Array<Omit<IssueExecutionStageParticipant, "id"> & { id?: string }>;
};

export interface WorkflowRetroSettings {
  routineId: string | null;
  autoTrigger: boolean;
  bounceThreshold: number;
  cooldownHours: number;
}

export interface WorkflowBlueprint {
  companyId: string;
  name: string;
  stages: WorkflowBlueprintStage[];
  returnEdges: WorkflowBlueprintReturnEdge[];
  mode: string;
  /** Chain attached to subtasks (no user participant); null = no default chain. */
  subtaskStages: WorkflowStageTemplate[] | null;
  /** Chain attached to top-level issues (ends in one all-user approval stage); null = no default chain. */
  featureStages: WorkflowStageTemplate[] | null;
  /** Operator halt phrases; null = use DEFAULT_HALT_PHRASES. */
  haltPhrases: string[] | null;
  intakeAgentId: string | null;
  gatedSubtaskKinds: string[];
  retro: WorkflowRetroSettings | null;
  prepareForMergeRoutineId: string | null;
  updatedAt: string | null;
}

export type WorkflowAdherenceEdgeKind = "forward" | "skip" | "backward" | "offpath";

export interface WorkflowAdherenceEdge {
  fromAgentId: string;
  toAgentId: string;
  count: number;
  kind: WorkflowAdherenceEdgeKind;
  medianDwellMs: number | null;
}

export interface WorkflowReworkLoop {
  fromAgentId: string;
  toAgentId: string;
  /** Total times this backward hand-off occurred (can include repeats within one ticket). */
  count: number;
  /** Number of distinct tickets it occurred in. */
  ticketCount: number;
  /** Up to 3 example ticket identifiers (not exhaustive). */
  exampleIssueIdentifiers: string[];
}

export interface WorkflowWorstTicket {
  issueId: string;
  identifier: string;
  hopCount: number;
  revisitCount: number;
}

export interface WorkflowAdherence {
  adherenceRate: number;
  cleanTicketCount: number;
  ticketCount: number;
  edges: WorkflowAdherenceEdge[];
  reworkLoops: WorkflowReworkLoop[];
  worstTickets: WorkflowWorstTicket[];
  windowDays: number;
  generatedAt: string;
}

/**
 * Per-agent retro metrics for one ticket tree.
 *
 * Definitions (stable; the retro facilitator and auto-trigger rely on them):
 * - bounce: a decision row with outcome `changes_requested`. `held` rows are never bounces.
 * - approvalsWithFindings: `approved` decisions whose body matches /\b(blocker|major|minor|nitpick)\b/i.
 * - changesRequestedReceived: `changes_requested` decisions on an issue where this agent had the
 *   last succeeded run finishing at or before the decision.
 * - wastedWakes: runs on a tree issue that ended (succeeded, failed, timed_out, cancelled) without
 *   producing a decision, a comment or an issue status change.
 */
export interface RetroAgentMetrics {
  agentId: string;
  agentName: string;
  runs: number;
  failedRuns: number;
  timedOutRuns: number;
  cancelledRuns: number;
  costCents: number;
  decisions: number;
  changesRequestedIssued: number;
  approvalsWithFindings: number;
  changesRequestedReceived: number;
  wastedWakes: number;
  wakeReasons: Record<string, number>;
}

export interface RetroBounceTimelineEntry {
  issueIdentifier: string;
  stageType: string;
  actorName: string;
  outcome: string;
  createdAt: string;
}

export interface RetroMetrics {
  rootIssueId: string;
  rootIdentifier: string;
  /** Root plus every descendant, resolved through parentId. */
  issueIds: string[];
  firstRunAt: string | null;
  doneAt: string | null;
  totals: {
    runs: number;
    costCents: number;
    decisions: number;
    bounces: number;
    cancelledRuns: number;
    wastedWakes: number;
    recoveryActions: number;
    missingCommentRetries: number;
  };
  agents: RetroAgentMetrics[];
  bounceTimeline: RetroBounceTimelineEntry[];
}
