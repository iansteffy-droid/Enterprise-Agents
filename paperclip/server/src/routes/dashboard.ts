import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { pendingHumanInputService } from "../services/pending-human-input.js";
import { assertCompanyAccess } from "./authz.js";

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);
  const pendingHumanInput = pendingHumanInputService(db);

  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  // Everything currently awaiting the human board user: pending approvals and
  // pending issue-thread interactions, merged and normalized for the dashboard
  // "Waiting on you" table (avoids an N+1 fetch loop in the UI).
  router.get("/companies/:companyId/pending-human-input", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const items = await pendingHumanInput.list(companyId);
    res.json(items);
  });

  return router;
}
