import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRetroPointsService = vi.hoisted(() => ({
  listRetroPoints: vi.fn(),
  setRetroPointStatus: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    retroPointsService: () => mockRetroPointsService,
    logActivity: mockLogActivity,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ retroPointRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/retro-points.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", retroPointRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const POINT_KEY = "22222222-2222-4222-8222-222222222222_1";

const boardActor = {
  type: "board",
  userId: "board-user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, membershipRole: "admin", status: "active" }],
};

const agentActor = {
  type: "agent",
  agentId: "agent-1",
  companyId: COMPANY_ID,
  source: "agent_key",
};

const otherCompanyAgentActor = {
  type: "agent",
  agentId: "agent-2",
  companyId: "33333333-3333-4333-8333-333333333333",
  source: "agent_key",
};

const PR_URL = "https://github.com/example/kit/pull/12";

function pointPath(pointKey = POINT_KEY) {
  return `/api/companies/${COMPANY_ID}/retro-points/${encodeURIComponent(pointKey)}`;
}

describe("retro points routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/retro-points.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockRetroPointsService.listRetroPoints.mockResolvedValue([]);
    // Mirror the real service contract: a status outside open | merged | rejected
    // is unprocessable (422); otherwise the upserted row comes back. The enum and
    // proposalRef checks themselves are covered against a real DB in the service test.
    mockRetroPointsService.setRetroPointStatus.mockImplementation(
      async (input: {
        status?: string;
        proposalRef?: string | null;
        note?: string | null;
        updatedByUserId?: string | null;
        updatedByAgentId?: string | null;
      }) => {
        const { unprocessable } = await import("../errors.js");
        const known = ["open", "merged", "rejected"];
        if (input.status !== undefined && !known.includes(input.status)) {
          throw unprocessable(`Unknown retro point status: ${input.status}`);
        }
        return {
          id: "row-1",
          companyId: COMPANY_ID,
          pointKey: POINT_KEY,
          status: input.status ?? "open",
          proposalRef: input.proposalRef ?? null,
          note: input.note ?? null,
          updatedByUserId: input.updatedByUserId ?? null,
          updatedByAgentId: input.updatedByAgentId ?? null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-02T00:00:00Z"),
        };
      },
    );
  });

  it("GET lists retro points for a board user with company access", async () => {
    mockRetroPointsService.listRetroPoints.mockResolvedValue([{ pointKey: POINT_KEY }]);
    const app = await createApp(boardActor);

    const res = await request(app).get(`/api/companies/${COMPANY_ID}/retro-points`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ pointKey: POINT_KEY }]);
    expect(mockRetroPointsService.listRetroPoints).toHaveBeenCalledWith(COMPANY_ID);
  });

  it("GET lists retro points for an agent of the company", async () => {
    const app = await createApp(agentActor);
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/retro-points`);
    expect(res.status).toBe(200);
  });

  it("PATCH by a board user upserts status and writes an activity-log entry", async () => {
    const app = await createApp(boardActor);

    const res = await request(app).patch(pointPath()).send({ status: "merged", note: "taken" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "merged", note: "taken" });

    expect(mockRetroPointsService.setRetroPointStatus).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      pointKey: POINT_KEY,
      status: "merged",
      note: "taken",
      updatedByUserId: "board-user-1",
      updatedByAgentId: null,
    });

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_ID,
        action: "retro_point.updated",
        entityType: "retro_point",
        entityId: POINT_KEY,
        details: { status: "merged", note: "taken" },
      }),
    );
  });

  it("PATCH by an agent of the company records status and proposalRef", async () => {
    const app = await createApp(agentActor);

    const res = await request(app).patch(pointPath()).send({ status: "open", proposalRef: PR_URL });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "open", proposalRef: PR_URL, updatedByAgentId: "agent-1" });
    expect(mockRetroPointsService.setRetroPointStatus).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      pointKey: POINT_KEY,
      status: "open",
      proposalRef: PR_URL,
      updatedByUserId: null,
      updatedByAgentId: "agent-1",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: "agent",
        agentId: "agent-1",
        details: { status: "open", proposalRef: PR_URL },
      }),
    );
  });

  it("PATCH accepts a branch reference and a null proposalRef", async () => {
    const app = await createApp(agentActor);

    const branch = await request(app).patch(pointPath()).send({ proposalRef: "branch:retro/ALP-7" });
    expect(branch.status).toBe(200);
    expect(mockRetroPointsService.setRetroPointStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ proposalRef: "branch:retro/ALP-7" }),
    );

    const cleared = await request(app).patch(pointPath()).send({ proposalRef: null });
    expect(cleared.status).toBe(200);
    expect(mockRetroPointsService.setRetroPointStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ proposalRef: null }),
    );
  });

  it("PATCH by an agent of another company is 403 and does not mutate", async () => {
    const app = await createApp(otherCompanyAgentActor);

    const res = await request(app).patch(pointPath()).send({ status: "open", proposalRef: PR_URL });

    expect(res.status).toBe(403);
    expect(mockRetroPointsService.setRetroPointStatus).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it.each(["done", "in_progress", "totally-not-a-status"])(
    "PATCH rejects status %s (outside open | merged | rejected) with 422",
    async (status) => {
      const app = await createApp(agentActor);

      const res = await request(app).patch(pointPath()).send({ status });

      expect(res.status).toBe(422);
      expect(mockLogActivity).not.toHaveBeenCalled();
    },
  );

  it("PATCH rejects a non-string proposalRef", async () => {
    const app = await createApp(agentActor);
    const res = await request(app).patch(pointPath()).send({ proposalRef: 42 });
    expect(res.status).toBe(400);
    expect(mockRetroPointsService.setRetroPointStatus).not.toHaveBeenCalled();
  });

  it("PATCH with neither status nor proposalRef is rejected", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).patch(pointPath()).send({});
    expect(res.status).toBe(400);
    expect(mockRetroPointsService.setRetroPointStatus).not.toHaveBeenCalled();
  });
});
