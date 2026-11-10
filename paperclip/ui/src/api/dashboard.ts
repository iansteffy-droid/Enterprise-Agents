import type { DashboardSummary, PendingHumanInputItem } from "@paperclipai/shared";
import { api } from "./client";

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  pendingHumanInput: (companyId: string) =>
    api.get<PendingHumanInputItem[]>(`/companies/${companyId}/pending-human-input`),
};
