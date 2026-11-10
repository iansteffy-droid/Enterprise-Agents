import type { AgentScorecard } from "@paperclipai/shared";
import { api } from "./client";

export const scorecardsApi = {
  get: (companyId: string, agentId: string) =>
    api.get<AgentScorecard>(`/companies/${companyId}/agents/${agentId}/scorecard`),
};
