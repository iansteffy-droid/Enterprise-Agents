import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("retro-metrics route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-retro-metrics-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyIds: string[]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user-1",
        companyIds,
        memberships: companyIds.map((companyId) => ({ companyId, membershipRole: "owner", status: "active" })),
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany(name: string, prefix: string) {
    const companyId = randomUUID();
    const rootId = randomUUID();
    await db.insert(companies).values({ id: companyId, name, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(issues).values({ id: rootId, companyId, title: "Root", identifier: `${prefix}-1`, issueNumber: 1 });
    return { companyId, rootId };
  }

  it("returns the tree metrics for a root in the caller's company", async () => {
    const own = await seedCompany("Own", "RMA");
    const res = await request(createApp([own.companyId])).get(
      `/api/companies/${own.companyId}/issues/${own.rootId}/retro-metrics`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      rootIssueId: own.rootId,
      rootIdentifier: "RMA-1",
      issueIds: [own.rootId],
      totals: { runs: 0, bounces: 0 },
      agents: [],
    });
  });

  it("404s for a missing root, a non-uuid id, and a root in another company", async () => {
    const own = await seedCompany("Own2", "RMB");
    const other = await seedCompany("Other", "RMC");
    const app = createApp([own.companyId]);
    const base = `/api/companies/${own.companyId}/issues`;
    expect((await request(app).get(`${base}/${randomUUID()}/retro-metrics`)).status).toBe(404);
    expect((await request(app).get(`${base}/not-a-uuid/retro-metrics`)).status).toBe(404);
    expect((await request(app).get(`${base}/${other.rootId}/retro-metrics`)).status).toBe(404);
  });

  it("denies access to a company the caller is not a member of", async () => {
    const own = await seedCompany("Own3", "RMD");
    const other = await seedCompany("Other2", "RME");
    const res = await request(createApp([own.companyId])).get(
      `/api/companies/${other.companyId}/issues/${other.rootId}/retro-metrics`,
    );
    expect(res.status).toBe(403);
  });
});
