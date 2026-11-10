import { api } from "./client";
import type { WorkflowGraph } from "./agents";
import type {
  WorkflowAdherence,
  WorkflowBlueprint,
  WorkflowBlueprintStage,
  WorkflowBlueprintReturnEdge,
  RetroMetrics,
  WorkflowBlueprintDefaultsInput,
} from "@paperclipai/shared";

export type {
  WorkflowAdherence,
  WorkflowBlueprint,
  WorkflowBlueprintStage,
  WorkflowBlueprintReturnEdge,
  RetroMetrics,
};

export interface SaveBlueprintInput {
  name?: string;
  stages: WorkflowBlueprintStage[];
  returnEdges: WorkflowBlueprintReturnEdge[];
}

/**
 * Chain/halt/intake/gating/retro settings save. The route requires `stages` and
 * `returnEdges`; callers pass the stored spine so only the settings change. Absent
 * settings keep their stored value, explicit null clears.
 */
export type SaveBlueprintSettingsInput = WorkflowBlueprintDefaultsInput & {
  stages: WorkflowBlueprintStage[];
  returnEdges: WorkflowBlueprintReturnEdge[];
  name?: string;
};

export const workflowApi = {
  graph: (companyId: string) =>
    api.get<WorkflowGraph>(`/companies/${companyId}/workflow`),
  getBlueprint: (companyId: string) =>
    api.get<WorkflowBlueprint | null>(`/companies/${companyId}/workflow/blueprint`),
  saveBlueprint: (companyId: string, input: SaveBlueprintInput) =>
    api.put<WorkflowBlueprint>(
      `/companies/${companyId}/workflow/blueprint`,
      input,
    ),
  saveBlueprintSettings: (companyId: string, input: SaveBlueprintSettingsInput) =>
    api.put<WorkflowBlueprint>(
      `/companies/${companyId}/workflow/blueprint`,
      input,
    ),
  adherence: (companyId: string) =>
    api.get<WorkflowAdherence>(`/companies/${companyId}/workflow/adherence`),
  // Compare real tickets against a spine that hasn't been saved yet.
  retroMetrics: (companyId: string, rootIssueId: string) =>
    api.get<RetroMetrics>(`/companies/${companyId}/issues/${rootIssueId}/retro-metrics`),
  previewAdherence: (companyId: string, input: SaveBlueprintInput) =>
    api.post<WorkflowAdherence>(
      `/companies/${companyId}/workflow/adherence/preview`,
      input,
    ),
};
