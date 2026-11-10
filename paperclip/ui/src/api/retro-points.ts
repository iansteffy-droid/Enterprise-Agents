import type { RetroPoint, RetroPointStatus } from "@paperclipai/shared";
import { RETRO_POINTS_API } from "@paperclipai/shared";
import { api } from "./client";

export interface SetRetroPointStatusInput {
  status?: RetroPointStatus;
  /** PR URL or `branch:<name>`; null clears it. */
  proposalRef?: string | null;
  note?: string | null;
}

/** Stored `retro_point_status` row returned by the PATCH endpoint. */
export interface RetroPointStatusRow {
  id: string;
  companyId: string;
  pointKey: string;
  status: RetroPointStatus;
  proposalRef: string | null;
  note: string | null;
  updatedByUserId: string | null;
  updatedByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const retroPointsApi = {
  list: (companyId: string) => api.get<RetroPoint[]>(RETRO_POINTS_API.list(companyId)),
  setStatus: (companyId: string, pointKey: string, body: SetRetroPointStatusInput) =>
    api.patch<RetroPointStatusRow>(RETRO_POINTS_API.point(companyId, pointKey), body),
};
