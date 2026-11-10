import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock services that agentRoutes depends on
// ---------------------------------------------------------------------------

const mockWorkflowBlueprintService = vi.hoisted(() => ({
  get: vi.fn(),
  upsert: vi.fn(),
}));

const mockWorkflowAdherenceService = vi.hoisted(() => ({
  compute: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

// Minimal stubs for other services imported by agentRoutes
const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  getById: vi.fn(async () => null),
  orgForCompany: vi.fn(async () => []),
  workflowForCompany: vi.fn(async () => ({ nodes: [], edges: [], meta: {} })),
}));

function registerModuleMocks() {
  vi.doMock("../services/workflow-blueprint.js", () => ({
    workflowBlueprintService: () => mockWorkflowBlueprintService,
    WorkflowBlueprintValidationError: class WorkflowBlueprintValidationError extends Error {
      status = 422 as const;
      code: string | undefined;
      constructor(message: string, code?: string) {
        super(message);
        this.name = "WorkflowBlueprintValidationError";
        this.code = code;
      }
    },
  }));

  vi.doMock("../services/workflow-adherence.js", () => ({
    workflowAdherenceService: () => mockWorkflowAdherenceService,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({ getBundle: vi.fn(), exportFiles: vi.fn() }),
    accessService: () => ({ canUser: vi.fn(async () => false), decide: vi.fn(), hasPermission: vi.fn(async () => false) }),
    approvalService: () => ({}),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    environmentService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => ({ getActiveForIssue: vi.fn(async () => null), listActiveForIssues: vi.fn(async () => new Map()) }),
    issueService: () => ({ getById: vi.fn(async () => null) }),
    logActivity: mockLogActivity,
    secretService: () => ({
      resolveAdapterConfigForRuntime: vi.fn(),
      normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
    }),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent: unknown, config: unknown) => config),
    workspaceOperationService: () => ({}),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
      })),
    }),
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => ({}),
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn((_type: string) => ({ type: _type })),
    listAdapterModels: vi.fn(),
  }));
}

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  // Set up board actor with company-1 access
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = "company-1";
const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UNKNOWN_AGENT_ID = "00000000-0000-0000-0000-000000000000";

function makeSavedBlueprint(overrides?: Partial<{ name: string }>) {
  return {
    companyId: COMPANY_ID,
    name: overrides?.name ?? "The Perfect Run",
    stages: [{ key: "intake", label: "Intake", position: 0, agentIds: [AGENT_ID] }],
    returnEdges: [],
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("workflow blueprint routes", () => {
  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    vi.clearAllMocks();
  });

  it("PUT then GET round-trips a blueprint for a board actor", async () => {
    const blueprint = makeSavedBlueprint();
    mockWorkflowBlueprintService.upsert.mockResolvedValue(blueprint);
    mockWorkflowBlueprintService.get.mockResolvedValue(blueprint);
    mockLogActivity.mockResolvedValue(undefined);

    const app = await createApp();

    const putBody = {
      name: "The Perfect Run",
      stages: [{ key: "intake", label: "Intake", position: 0, agentIds: [AGENT_ID] }],
      returnEdges: [],
    };
    const put = await request(app)
      .put(`/api/companies/${COMPANY_ID}/workflow/blueprint`)
      .send(putBody);

    expect(put.status).toBe(200);
    expect(put.body.stages[0].agentIds).toEqual([AGENT_ID]);

    // Assert the route forwarded the right arguments to the service
    expect(mockWorkflowBlueprintService.upsert).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        stages: putBody.stages,
        returnEdges: putBody.returnEdges,
        createdByUserId: "local-board", // board actor userId
        createdByAgentId: null,         // user actor has no agentId
      }),
    );

    // Assert activity log was written with the correct action
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "workflow.blueprint_updated" }),
    );

    const get = await request(app).get(`/api/companies/${COMPANY_ID}/workflow/blueprint`);
    expect(get.status).toBe(200);
    expect(get.body.name).toBe("The Perfect Run");
    // Assert the route called the service with the correct companyId
    expect(mockWorkflowBlueprintService.get).toHaveBeenCalledWith(COMPANY_ID);
  });

  it("returns 422 for an unknown agent id", async () => {
    const { WorkflowBlueprintValidationError } = await import("../services/workflow-blueprint.js");
    mockWorkflowBlueprintService.upsert.mockRejectedValue(
      new WorkflowBlueprintValidationError(
        `blueprint references agents not in company: ${UNKNOWN_AGENT_ID}`,
      ),
    );

    const app = await createApp();

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/workflow/blueprint`)
      .send({
        name: "x",
        returnEdges: [],
        stages: [{ key: "s", label: "S", position: 0, agentIds: [UNKNOWN_AGENT_ID] }],
      });

    expect(res.status).toBe(422);
  });

  it("PUT /companies/:id/workflow/blueprint round-trips the default chains and logs workflow.blueprint_updated", async () => {
    const featureStages = [
      {
        type: "review",
        approvalsNeeded: 1,
        participants: [{ type: "agent", agentId: AGENT_ID }],
      },
      {
        type: "approval",
        approvalsNeeded: 1,
        participants: [{ type: "user", userId: "board-user" }],
      },
    ];
    const saved = {
      ...makeSavedBlueprint(),
      mode: "standard",
      subtaskStages: null,
      featureStages,
      haltPhrases: ["stop"],
      intakeAgentId: AGENT_ID,
      gatedSubtaskKinds: ["impl"],
      retro: { routineId: null, autoTrigger: false, bounceThreshold: 2, cooldownHours: 24 },
      prepareForMergeRoutineId: null,
    };
    mockWorkflowBlueprintService.upsert.mockResolvedValue(saved);
    mockWorkflowBlueprintService.get.mockResolvedValue(saved);

    const app = await createApp();
    const put = await request(app)
      .put(`/api/companies/${COMPANY_ID}/workflow/blueprint`)
      .send({
        stages: saved.stages,
        returnEdges: [],
        featureStages,
        haltPhrases: ["stop"],
        intakeAgentId: AGENT_ID,
        gatedSubtaskKinds: ["impl"],
        retro: {},
      });

    expect(put.status).toBe(200);
    expect(put.body.featureStages).toHaveLength(2);
    const upsertInput = mockWorkflowBlueprintService.upsert.mock.calls[0][1];
    expect(upsertInput).toMatchObject({
      haltPhrases: ["stop"],
      intakeAgentId: AGENT_ID,
      gatedSubtaskKinds: ["impl"],
      retro: { routineId: null, autoTrigger: false, bounceThreshold: 2, cooldownHours: 24 },
    });
    expect(upsertInput.featureStages).toHaveLength(2);
    // Fields the body omitted stay undefined so the service keeps the stored value.
    expect(upsertInput.subtaskStages).toBeUndefined();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "workflow.blueprint_updated" }),
    );

    const get = await request(app).get(`/api/companies/${COMPANY_ID}/workflow/blueprint`);
    expect(get.body.intakeAgentId).toBe(AGENT_ID);
    expect(get.body.haltPhrases).toEqual(["stop"]);
  });

  it("PUT with an invalid chain returns 422 with code execution_policy_level_invariant", async () => {
    const { WorkflowBlueprintValidationError } = await import("../services/workflow-blueprint.js");
    mockWorkflowBlueprintService.upsert.mockRejectedValue(
      new WorkflowBlueprintValidationError(
        "A top-level execution policy must end in an approval stage",
        "execution_policy_level_invariant",
      ),
    );

    const app = await createApp();
    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/workflow/blueprint`)
      .send({
        stages: [],
        returnEdges: [],
        featureStages: [
          { type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: AGENT_ID }] },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("execution_policy_level_invariant");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("PUT with a malformed default setting returns 422 before reaching the service", async () => {
    const app = await createApp();
    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/workflow/blueprint`)
      .send({ stages: [], returnEdges: [], intakeAgentId: "not-a-uuid" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("workflow_blueprint_invalid");
    expect(mockWorkflowBlueprintService.upsert).not.toHaveBeenCalled();
  });

  it("PUT returns 400 when stages is not an array", async () => {
    const app = await createApp();

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/workflow/blueprint`)
      .send({ stages: "nope", returnEdges: [] });

    expect(res.status).toBe(400);
    expect(mockWorkflowBlueprintService.upsert).not.toHaveBeenCalled();
  });

  it("PUT returns 400 when returnEdges is not an array", async () => {
    const app = await createApp();

    const res = await request(app)
      .put(`/api/companies/${COMPANY_ID}/workflow/blueprint`)
      .send({ stages: [], returnEdges: "nope" });

    expect(res.status).toBe(400);
    expect(mockWorkflowBlueprintService.upsert).not.toHaveBeenCalled();
  });

  it("GET /workflow/adherence returns adherence metrics computed from the saved blueprint", async () => {
    const blueprint = makeSavedBlueprint();
    const adherenceResult = {
      companyId: COMPANY_ID,
      onTrackCount: 3,
      offTrackCount: 1,
      adherenceRate: 0.75,
      stageMetrics: [],
    };
    mockWorkflowBlueprintService.get.mockResolvedValue(blueprint);
    mockWorkflowAdherenceService.compute.mockResolvedValue(adherenceResult);

    const app = await createApp();

    const res = await request(app).get(`/api/companies/${COMPANY_ID}/workflow/adherence`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(adherenceResult);

    // Assert the route wired up the right companyId and forwarded the blueprint
    expect(mockWorkflowBlueprintService.get).toHaveBeenCalledWith(COMPANY_ID);
    expect(mockWorkflowAdherenceService.compute).toHaveBeenCalledWith(COMPANY_ID, blueprint);
  });

  it("POST /workflow/adherence/preview computes against the supplied (unsaved) spine", async () => {
    const adherenceResult = {
      adherenceRate: 0.5,
      cleanTicketCount: 1,
      ticketCount: 2,
      edges: [],
      reworkLoops: [],
      worstTickets: [],
      windowDays: 14,
      generatedAt: "",
    };
    mockWorkflowAdherenceService.compute.mockResolvedValue(adherenceResult);

    const app = await createApp();
    const body = {
      name: "The Perfect Run",
      stages: [{ key: "intake", label: "Intake", position: 0, agentIds: [AGENT_ID] }],
      returnEdges: [],
    };

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/workflow/adherence/preview`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(adherenceResult);
    // compute is called with a blueprint built from the request body, not the saved one.
    expect(mockWorkflowAdherenceService.compute).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        companyId: COMPANY_ID,
        stages: body.stages,
        returnEdges: body.returnEdges,
      }),
    );
  });
});
