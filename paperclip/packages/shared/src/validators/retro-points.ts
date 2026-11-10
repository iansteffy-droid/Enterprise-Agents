import { z } from "zod";
import { RETRO_POINT_STATUSES } from "../types/retro-points.js";

/** Strict status enum, for callers that want compile-time / client-side validation. */
export const retroPointStatusSchema = z.enum(RETRO_POINT_STATUSES);

/**
 * Request-body schema for `PATCH /companies/:companyId/retro-points/:pointId`.
 *
 * `status` is a plain string here (not the enum) so that a value outside
 * open | merged | rejected is rejected with 422 by the service, not with a 400
 * from the validate() middleware; the same holds for a malformed `proposalRef`.
 * An absent field keeps the stored value; `proposalRef: null` clears it.
 */
export const setRetroPointStatusSchema = z
  .object({
    status: z.string().trim().min(1).optional(),
    proposalRef: z.string().trim().max(2000).nullable().optional(),
    note: z.string().trim().max(2000).optional().nullable(),
  })
  .refine((body) => body.status !== undefined || body.proposalRef !== undefined, {
    message: "Provide status, proposalRef, or both",
  });

export type SetRetroPointStatusBody = z.infer<typeof setRetroPointStatusSchema>;
