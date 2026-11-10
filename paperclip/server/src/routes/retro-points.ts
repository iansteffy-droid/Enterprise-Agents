import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { setRetroPointStatusSchema, type SetRetroPointStatusBody } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, retroPointsService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function retroPointRoutes(db: Db) {
  const router = Router();
  const svc = retroPointsService(db);

  // Company read access: retro points, content re-derived live.
  router.get("/companies/:companyId/retro-points", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const points = await svc.listRetroPoints(companyId);
    res.json(points);
  });

  // Board users and agents of the company: upsert a point's status and/or proposal
  // reference. The retro facilitator agent records `{ status: "open", proposalRef }`;
  // the human sets merged or rejected. assertCompanyAccess keeps an agent to its
  // own company and a board user to an active, non-viewer membership.
  router.patch(
    "/companies/:companyId/retro-points/:pointId",
    validate(setRetroPointStatusSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const pointKey = req.params.pointId as string;
      assertCompanyAccess(req, companyId);

      const body = req.body as SetRetroPointStatusBody;
      const actor = getActorInfo(req);
      const changes = {
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.proposalRef !== undefined ? { proposalRef: body.proposalRef } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      };
      const row = await svc.setRetroPointStatus({
        companyId,
        pointKey,
        ...changes,
        updatedByUserId: actor.actorType === "user" ? actor.actorId : null,
        updatedByAgentId: actor.actorType === "agent" ? actor.agentId : null,
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "retro_point.updated",
        entityType: "retro_point",
        entityId: pointKey,
        details: changes,
      });

      res.json(row);
    },
  );

  return router;
}
