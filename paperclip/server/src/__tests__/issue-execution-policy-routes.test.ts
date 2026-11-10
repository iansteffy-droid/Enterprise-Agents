import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueLabels,
  issues,
  labels,
  workflowBlueprints,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler as realErrorHandler } from "../middleware/index.js";
import { issueRoutes as realIssueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(async () => []),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentGetById = vi.hoisted(() => vi.fn(async (agentId: string) => ({
  id: agentId,
  companyId: "company-1",
  permissions: null,
})));
const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  decide: vi.fn(),
  hasPermission: vi.fn(async () => false),
}));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{
      companyId: "company-1",
      agentId: "33333333-3333-4333-8333-333333333333",
      contextSnapshot: null,
      permissions: null,
    }]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: mockAgentGetById,
      resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: {
          id: reference,
          companyId: "company-1",
          status: "idle",
          orgChainHealth: { status: "healthy" },
        },
      })),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({
      getById: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      source: "local_implicit";
      isInstanceAdmin: boolean;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      runId: string | null;
    };

async function createApp(actor?: TestActor) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue execution policy routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{
          companyId: "company-1",
          agentId: "33333333-3333-4333-8333-333333333333",
          contextSnapshot: null,
          permissions: null,
        }]).then(onFulfilled, onRejected),
    }));
    mockIssueService.createChild.mockResolvedValue({
      issue: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        companyId: "company-1",
        identifier: "PAP-1002",
        title: "Child issue",
      },
      parentBlockerAdded: false,
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
      const allowed = input.actor?.type === "board" && input.actor.source === "local_implicit"
        ? true
        : input.actor?.type === "agent" && [
            "company_scope:read",
            "issue:read",
            "issue:mutate",
            "runtime:manage",
          ].includes(input.action ?? "")
          ? true
          : Boolean(await mockAccessService.canUser() || await mockAccessService.hasPermission());
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("rejects an agent-authored in_review transition without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1003",
      title: "Missing review path",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid_issue_disposition");
    expect(res.body.error).toContain("request_confirmation");
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "review_path",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows an agent-authored in_review transition with a pending confirmation interaction", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      { id: "interaction-1", kind: "request_confirmation", status: "pending" },
    ]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ status: "in_review" }),
    );
  });

  it("allows an agent-authored in_review transition with a typed execution participant", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1005",
      title: "Execution participant",
      executionPolicy: null,
      executionState: null,
    };
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
        },
      ],
    })!;
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        executionState: expect.objectContaining({
          status: "pending",
          currentParticipant: expect.objectContaining({
            type: "agent",
            agentId: "44444444-4444-4444-8444-444444444444",
          }),
        }),
      }),
    );
  });

  it("allows an agent-authored in_review transition with a scheduled monitor", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1006",
      title: "External review monitor",
      executionPolicy: null,
      executionState: null,
      monitorAttemptCount: 0,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
      monitorNotes: null,
      monitorScheduledBy: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-12-01T12:00:00.000Z",
            scheduledBy: "assignee",
            notes: "Wait for external QA report.",
          },
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        monitorNextCheckAt: new Date("2026-12-01T12:00:00.000Z"),
      }),
    );
  });

  it("allows board-authored in_review repair updates without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1007",
      title: "Board repair",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueThreadInteractionService.listForIssue).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });

  it("does not auto-start execution review when reviewers are added to an already in_review issue", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-999",
      title: "Execution policy edit",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: policy,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBeUndefined();
    expect(updatePatch.assigneeAgentId).toBeUndefined();
    expect(updatePatch.assigneeUserId).toBeUndefined();
    expect(updatePatch.executionState).toBeUndefined();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("triggers a scheduled monitor immediately from the dedicated route", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Manual monitor trigger",
      executionPolicy: normalizeIssueExecutionPolicy({
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      }),
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/monitor/check-now")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockHeartbeatService.triggerIssueMonitor).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        actorType: "user",
        actorId: "local-board",
        agentId: null,
      }),
    );
  });

  it("lets a board user create a child issue with a scheduled monitor", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "assignee",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("board");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        details: expect.objectContaining({
          scheduledBy: "board",
        }),
      }),
    );
  });

  it("rejects child monitor scheduling by a non-assignee agent even with task assignment permission", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the assignee agent or a board user can manage issue monitors");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("normalizes spoofed child monitor scheduledBy to the assignee actor", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
            externalRef: "https://example.test/deploy?token=secret",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string; externalRef: string | null } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("assignee");
    expect(createPayload.executionPolicy.monitor.externalRef).toBe("[redacted]");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        entityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        details: expect.not.objectContaining({ externalRef: expect.anything() }),
      }),
    );
  });
  it("rejects attaching an execution policy whose agent participant is not invokable", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1010",
      title: "Paused reviewer",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockAgentGetById.mockResolvedValueOnce({
      id: "44444444-4444-4444-8444-444444444444",
      companyId: "company-1",
      name: "Paused QA",
      status: "paused",
      permissions: null,
    });

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        executionPolicy: {
          stages: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              type: "review",
              participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
            },
          ],
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "execution_policy_participant_not_invokable",
      participants: [
        expect.objectContaining({ agentId: "44444444-4444-4444-8444-444444444444", status: "paused" }),
      ],
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("surfaces a non-invokable wake target as a system comment on the issue thread", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1011",
      title: "Wake target paused after attach",
      executionPolicy: null,
      executionState: null,
    };
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
        },
      ],
    })!;
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockHeartbeatService.wakeup.mockRejectedValue(new Error("Agent is not invokable in its current state"));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", executionPolicy: policy });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockIssueService.addComment).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expect.stringContaining("non-invokable-wake:44444444-4444-4444-8444-444444444444"),
        {},
        expect.objectContaining({ authorType: "system" }),
      );
    });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("company default execution chains (issue routes, real DB)", () => {
  const BOARD_USER_ID = "board-user-1";
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-default-chain-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueLabels);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(labels);
    await db.delete(workflowBlueprints);
    await db.delete(companyMemberships);
    // Assignment wakes are fire-and-forget; let any in flight settle before removing agents.
    await vi.waitFor(async () => {
      await db.delete(agentWakeupRequests);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
    });
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type Actor = Express.Request["actor"];

  function boardActor(companyId: string): Actor {
    return {
      type: "board",
      userId: BOARD_USER_ID,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
      source: "local_implicit",
    };
  }

  function agentActor(companyId: string, agentId: string): Actor {
    return { type: "agent", agentId, companyId, runId: null, source: "agent_jwt" };
  }

  function app(actor: Actor) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    server.use("/api", realIssueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null }));
    server.use(realErrorHandler);
    return server;
  }

  async function seed(options: { blueprint?: boolean; qaStatus?: string } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Chain Co",
      issuePrefix: `C${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    const ids = {
      intake: randomUUID(),
      dispatcher: randomUUID(),
      dev: randomUUID(),
      qa: randomUUID(),
      reviewer: randomUUID(),
    };
    await db.insert(agents).values(
      Object.entries(ids).map(([name, id]) => ({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        // On-demand wakes are off so no adapter ever launches.
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        permissions: { canCreateAgents: false },
      })),
    );
    const [repro, tests] = await db
      .insert(labels)
      .values([
        { companyId, name: "kind:repro", color: "#aa0000" },
        { companyId, name: "kind:tests", color: "#00aa00" },
      ])
      .returning();
    if (options.blueprint !== false) {
      await db.insert(workflowBlueprints).values({
        companyId,
        intakeAgentId: ids.intake,
        subtaskStages: [
          { type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: ids.reviewer, userId: null }] },
        ],
        featureStages: [
          { type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: ids.qa, userId: null }] },
          { type: "approval", approvalsNeeded: 1, participants: [{ type: "user", agentId: null, userId: BOARD_USER_ID }] },
        ],
      });
    }
    if (options.qaStatus) {
      // Paused after the blueprint was saved.
      await db.update(agents).set({ status: options.qaStatus }).where(eq(agents.id, ids.qa));
    }
    return { companyId, ...ids, reproLabelId: repro!.id, testsLabelId: tests!.id };
  }

  async function readIssue(issueId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    return row!;
  }

  async function createTopLevel(companyId: string, body: Record<string, unknown>, actor?: Actor) {
    return request(app(actor ?? boardActor(companyId)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Feature", ...body });
  }

  function stageTypes(policy: unknown) {
    return ((policy as { stages?: Array<{ type: string }> } | null)?.stages ?? []).map((stage) => stage.type);
  }

  function featurePolicy(qaAgentId: string) {
    return {
      mode: "normal",
      commentRequired: true,
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
        { type: "approval", participants: [{ type: "user", userId: BOARD_USER_ID }] },
      ],
    };
  }

  it("top-level created by the board assigned to the dispatcher gets the feature chain at creation", async () => {
    const co = await seed();
    const res = await createTopLevel(co.companyId, { assigneeAgentId: co.dispatcher });

    expect(res.status).toBe(201);
    expect(stageTypes(res.body.executionPolicy)).toEqual(["review", "approval"]);
    expect(res.body.executionPolicy.commentRequired).toBe(true);
    const row = await readIssue(res.body.id);
    expect(row.leftIntakeAt).toBeInstanceOf(Date);
    expect(row.executionState).toBeNull();
    const attached = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, res.body.id), eq(activityLog.action, "issue.execution_policy_attached")));
    expect(attached).toHaveLength(1);
    expect(attached[0]!.details).toMatchObject({ source: "company_default", level: "top_level", reason: "left_intake" });
  });

  it("top-level created assigned to the intake agent gets no chain; park in_review to the board user arms nothing; PATCH assignee to dispatcher attaches the chain", async () => {
    const co = await seed();
    const created = await createTopLevel(co.companyId, { assigneeAgentId: co.intake });
    expect(created.status).toBe(201);
    expect(created.body.executionPolicy ?? null).toBeNull();
    expect((await readIssue(created.body.id)).leftIntakeAt).toBeNull();

    const parked = await request(app(agentActor(co.companyId, co.intake)))
      .patch(`/api/issues/${created.body.id}`)
      .send({ status: "in_review", assigneeAgentId: null, assigneeUserId: BOARD_USER_ID });
    expect(parked.status).toBe(200);
    const afterPark = await readIssue(created.body.id);
    expect(afterPark.status).toBe("in_review");
    expect(afterPark.executionPolicy).toBeNull();
    expect(afterPark.executionState).toBeNull();
    expect(afterPark.leftIntakeAt).toBeNull();
    // Nothing armed, so the first chain participant was never woken.
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, co.qa))).toHaveLength(0);

    const dispatched = await request(app(boardActor(co.companyId)))
      .patch(`/api/issues/${created.body.id}`)
      .send({ status: "todo", assigneeAgentId: co.dispatcher, assigneeUserId: null });
    expect(dispatched.status).toBe(200);
    const afterDispatch = await readIssue(created.body.id);
    expect(stageTypes(afterDispatch.executionPolicy)).toEqual(["review", "approval"]);
    expect(afterDispatch.executionState).toBeNull();
    expect(afterDispatch.leftIntakeAt).toBeInstanceOf(Date);
  });

  it("POST /companies/:id/issues attaches the top-level default and the chain arms on in_review", async () => {
    const co = await seed();
    const created = await createTopLevel(co.companyId, { assigneeAgentId: co.dev });
    expect(created.status).toBe(201);
    expect(stageTypes(created.body.executionPolicy)).toEqual(["review", "approval"]);

    const res = await request(app(boardActor(co.companyId)))
      .patch(`/api/issues/${created.body.id}`)
      .send({ status: "in_review" });
    expect(res.status).toBe(200);
    const row = await readIssue(created.body.id);
    expect(row.status).toBe("in_review");
    expect(row.assigneeAgentId).toBe(co.qa);
    expect(row.executionState).toMatchObject({ status: "pending", currentStageType: "review" });
  });

  it("POST /issues/:parentId/children attaches the subtask default", async () => {
    const co = await seed();
    const parent = await createTopLevel(co.companyId, { assigneeAgentId: co.dispatcher });
    const board = app(boardActor(co.companyId));

    const impl = await request(board).post(`/api/issues/${parent.body.id}/children`).send({ title: "Impl" });
    expect(impl.status).toBe(201);
    expect(stageTypes(impl.body.executionPolicy)).toEqual(["review"]);
    expect(impl.body.executionPolicy.stages[0].participants[0]).toMatchObject({ agentId: co.reviewer });
    expect((await readIssue(impl.body.id)).leftIntakeAt).toBeNull();

    const tests = await request(board)
      .post(`/api/issues/${parent.body.id}/children`)
      .send({ title: "Tests", labelIds: [co.testsLabelId] });
    expect(stageTypes(tests.body.executionPolicy)).toEqual(["review"]);

    const repro = await request(board)
      .post(`/api/issues/${parent.body.id}/children`)
      .send({ title: "Repro", labelIds: [co.reproLabelId] });
    expect(repro.status).toBe(201);
    expect(repro.body.executionPolicy ?? null).toBeNull();

    const viaCompanyRoute = await createTopLevel(co.companyId, { title: "Child via company route", parentId: parent.body.id });
    expect(viaCompanyRoute.status).toBe(201);
    expect(stageTypes(viaCompanyRoute.body.executionPolicy)).toEqual(["review"]);
  });

  it("attaches the default even when the template agent is paused, and posts the non-invokable warning comment instead of 422", async () => {
    const co = await seed({ qaStatus: "paused" });
    const res = await createTopLevel(co.companyId, { assigneeAgentId: co.dispatcher });

    expect(res.status).toBe(201);
    expect(stageTypes(res.body.executionPolicy)).toEqual(["review", "approval"]);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, res.body.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain(`<!-- non-invokable-wake:${co.qa} -->`);
    expect(comments[0]!.body).toContain("execution_policy_participant_not_invokable");
  });

  it("PATCH parentId null→set on an issue with no decisions swaps to the subtask default", async () => {
    const co = await seed();
    const parent = await createTopLevel(co.companyId, { title: "Parent" });
    const issue = await createTopLevel(co.companyId, { assigneeAgentId: co.dev });
    expect(stageTypes(issue.body.executionPolicy)).toEqual(["review", "approval"]);

    const res = await request(app(boardActor(co.companyId)))
      .patch(`/api/issues/${issue.body.id}`)
      .send({ parentId: parent.body.id });
    expect(res.status).toBe(200);
    const row = await readIssue(issue.body.id);
    expect(row.parentId).toBe(parent.body.id);
    expect(stageTypes(row.executionPolicy)).toEqual(["review"]);
    expect(row.leftIntakeAt).toBeNull();
  });

  it("PATCH parentId set→null on an issue with decisions returns 422 unless a valid top-level policy is supplied", async () => {
    const co = await seed();
    const parent = await createTopLevel(co.companyId, { title: "Parent" });
    const child = await request(app(boardActor(co.companyId)))
      .post(`/api/issues/${parent.body.id}/children`)
      .send({ title: "Child", assigneeAgentId: co.dev });
    const stageId = child.body.executionPolicy.stages[0].id as string;
    await db.insert(issueExecutionDecisions).values({
      companyId: co.companyId,
      issueId: child.body.id,
      stageId,
      stageType: "review",
      actorAgentId: co.reviewer,
      outcome: "changes_requested",
      body: "Needs work",
    });
    const board = app(boardActor(co.companyId));

    const bare = await request(board).patch(`/api/issues/${child.body.id}`).send({ parentId: null });
    expect(bare.status).toBe(422);
    expect(bare.body.details).toMatchObject({ code: "execution_policy_level_invariant" });

    const subtaskShaped = await request(board)
      .patch(`/api/issues/${child.body.id}`)
      .send({
        parentId: null,
        executionPolicy: { stages: [{ type: "review", participants: [{ type: "agent", agentId: co.qa }] }] },
      });
    expect(subtaskShaped.status).toBe(422);
    expect(subtaskShaped.body.details).toMatchObject({ code: "execution_policy_level_invariant" });
    expect(stageTypes((await readIssue(child.body.id)).executionPolicy)).toEqual(["review"]);

    const valid = await request(board)
      .patch(`/api/issues/${child.body.id}`)
      .send({ parentId: null, executionPolicy: featurePolicy(co.qa) });
    expect(valid.status).toBe(200);
    const row = await readIssue(child.body.id);
    expect(row.parentId).toBeNull();
    expect(stageTypes(row.executionPolicy)).toEqual(["review", "approval"]);
  });

  it("PATCH executionPolicy by an agent that names itself returns 422 execution_policy_self_participant", async () => {
    const co = await seed();
    const parent = await createTopLevel(co.companyId, { title: "Parent" });
    const child = await request(app(boardActor(co.companyId)))
      .post(`/api/issues/${parent.body.id}/children`)
      .send({ title: "Child", assigneeAgentId: co.dispatcher, labelIds: [co.reproLabelId] });

    const res = await request(app(agentActor(co.companyId, co.dispatcher)))
      .patch(`/api/issues/${child.body.id}`)
      .send({ executionPolicy: { stages: [{ type: "review", participants: [{ type: "agent", agentId: co.dispatcher }] }] } });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "execution_policy_self_participant" });
    expect((await readIssue(child.body.id)).executionPolicy).toBeNull();
  });

  async function seedActiveReview() {
    const co = await seed();
    const res = await createTopLevel(co.companyId, { title: "Reviewable", assigneeAgentId: co.dev });
    expect(res.status).toBe(201);
    const issueId = res.body.id as string;
    // Put the issue into an active review stage owned by qa, returning to dev.
    const normalized = normalizeIssueExecutionPolicy(featurePolicy(co.qa))!;
    const stageId = normalized.stages[0]!.id;
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: co.qa,
      executionPolicy: normalized as any,
    }).where(eq(issues.id, issueId));
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: co.qa },
        returnAssignee: { type: "agent", agentId: co.dev },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      } as any,
    }).where(eq(issues.id, issueId));
    return { co, issueId };
  }

  it("agent PATCH executionDecision approve without status advances the active review stage", async () => {
    const { co, issueId } = await seedActiveReview();
    const res = await request(app(agentActor(co.companyId, co.qa)))
      .patch(`/api/issues/${issueId}`)
      .send({ executionDecision: "approve", comment: "Looks good" });
    expect(res.status).toBe(200);
    const row = await readIssue(issueId);
    expect(row.executionState).toMatchObject({ status: "pending", currentStageType: "approval" });
  });

  it("agent PATCH approve with a mismatched status returns 422 execution_decision_status_mismatch", async () => {
    const { co, issueId } = await seedActiveReview();
    const res = await request(app(agentActor(co.companyId, co.qa)))
      .patch(`/api/issues/${issueId}`)
      .send({ executionDecision: "approve", status: "in_progress", comment: "Looks good" });
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "execution_decision_status_mismatch" });
    expect((await readIssue(issueId)).executionState).toMatchObject({ currentStageType: "review" });
  });

  it("agent PATCH bare status done on an active stage returns 422 execution_decision_required", async () => {
    const { co, issueId } = await seedActiveReview();
    const res = await request(app(agentActor(co.companyId, co.qa)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Looks good" });
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "execution_decision_required" });
    expect((await readIssue(issueId)).status).toBe("in_review");
  });

  it("ignores an agent's explicit null on PATCH and keeps the chain", async () => {
    const co = await seed();
    const issue = await createTopLevel(co.companyId, { assigneeAgentId: co.dev });

    const res = await request(app(agentActor(co.companyId, co.dev)))
      .patch(`/api/issues/${issue.body.id}`)
      .send({ executionPolicy: null });

    expect(res.status).toBe(200);
    expect(stageTypes((await readIssue(issue.body.id)).executionPolicy)).toEqual(["review", "approval"]);
  });

  it("returns 422 execution_policy_required when a post-intake top-level issue is set in_review or done without a chain", async () => {
    const co = await seed();
    const issue = await createTopLevel(co.companyId, { assigneeAgentId: co.dev });
    // Simulate a chain that went missing after the issue left intake.
    await db.update(issues).set({ executionPolicy: null }).where(eq(issues.id, issue.body.id));
    const board = app(boardActor(co.companyId));

    for (const status of ["in_review", "done"]) {
      const res = await request(board).patch(`/api/issues/${issue.body.id}`).send({ status });
      expect(res.status).toBe(422);
      expect(res.body.details).toMatchObject({ code: "execution_policy_required" });
    }

    // A board user's explicit null ungates the issue on purpose.
    const ungated = await request(board).patch(`/api/issues/${issue.body.id}`).send({ executionPolicy: null });
    expect(ungated.status).toBe(200);
    expect((await readIssue(issue.body.id)).leftIntakeAt).toBeNull();
    const review = await request(board).patch(`/api/issues/${issue.body.id}`).send({ status: "in_review" });
    expect(review.status).toBe(200);
  });

  it("honours a board user's explicit null at creation", async () => {
    const co = await seed();
    const res = await createTopLevel(co.companyId, { assigneeAgentId: co.dispatcher, executionPolicy: null });
    expect(res.status).toBe(201);
    expect(res.body.executionPolicy ?? null).toBeNull();
    expect((await readIssue(res.body.id)).leftIntakeAt).toBeNull();
  });

  it("keeps a board user's explicit null across later assignments out of intake and a level change", async () => {
    const co = await seed();
    const board = app(boardActor(co.companyId));
    const parent = await createTopLevel(co.companyId, { title: "Parent" });
    const starts: Array<Record<string, unknown>> = [
      { assigneeAgentId: co.intake },
      { assigneeUserId: BOARD_USER_ID },
      {},
    ];
    for (const start of starts) {
      const issue = await createTopLevel(co.companyId, start);
      const ungated = await request(board).patch(`/api/issues/${issue.body.id}`).send({ executionPolicy: null });
      expect(ungated.status).toBe(200);
      expect((await readIssue(issue.body.id)).executionPolicyUngatedAt).toBeInstanceOf(Date);

      const out = await request(board)
        .patch(`/api/issues/${issue.body.id}`)
        .send({ assigneeAgentId: co.dispatcher, assigneeUserId: null });
      expect(out.status).toBe(200);
      const row = await readIssue(issue.body.id);
      expect(row.executionPolicy).toBeNull();
      expect(row.leftIntakeAt).toBeNull();

      const moved = await request(board).patch(`/api/issues/${issue.body.id}`).send({ parentId: parent.body.id });
      expect(moved.status).toBe(200);
      expect((await readIssue(issue.body.id)).executionPolicy).toBeNull();
      const back = await request(board).patch(`/api/issues/${issue.body.id}`).send({ parentId: null });
      expect(back.status).toBe(200);
      expect((await readIssue(issue.body.id)).executionPolicy).toBeNull();
    }
  });

  it("keeps a board user's explicit null at creation through intake and then the dispatcher", async () => {
    const co = await seed();
    const board = app(boardActor(co.companyId));
    const issue = await createTopLevel(co.companyId, { executionPolicy: null });
    expect((await readIssue(issue.body.id)).executionPolicyUngatedAt).toBeInstanceOf(Date);

    expect((await request(board).patch(`/api/issues/${issue.body.id}`).send({ assigneeAgentId: co.intake })).status).toBe(200);
    expect((await request(board).patch(`/api/issues/${issue.body.id}`).send({ assigneeAgentId: co.dispatcher })).status).toBe(200);
    const row = await readIssue(issue.body.id);
    expect(row.executionPolicy).toBeNull();
    expect(row.leftIntakeAt).toBeNull();

    // A board user setting a policy lifts the ungated marker.
    const gated = await request(board).patch(`/api/issues/${issue.body.id}`).send({ executionPolicy: featurePolicy(co.qa) });
    expect(gated.status).toBe(200);
    expect((await readIssue(issue.body.id)).executionPolicyUngatedAt).toBeNull();
  });

  async function checkoutAs(co: { companyId: string }, agentId: string, issueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: co.companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
    });
    return request(app({ type: "agent", agentId, companyId: co.companyId, runId, source: "agent_jwt" }))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo", "backlog"] });
  }

  it("checkout by a non-intake agent takes the issue out of intake and attaches the feature chain", async () => {
    const co = await seed();
    const issue = await createTopLevel(co.companyId, { status: "todo" });
    expect(issue.body.executionPolicy ?? null).toBeNull();

    const res = await checkoutAs(co, co.dispatcher, issue.body.id);
    expect(res.status).toBe(200);
    expect(stageTypes(res.body.executionPolicy)).toEqual(["review", "approval"]);
    const row = await readIssue(issue.body.id);
    expect(row.assigneeAgentId).toBe(co.dispatcher);
    expect(stageTypes(row.executionPolicy)).toEqual(["review", "approval"]);
    expect(row.leftIntakeAt).toBeInstanceOf(Date);
    const attached = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issue.body.id), eq(activityLog.action, "issue.execution_policy_attached")));
    expect(attached[0]?.details).toMatchObject({ reason: "left_intake" });
  });

  it("checkout of a board-ungated issue attaches nothing", async () => {
    const co = await seed();
    const issue = await createTopLevel(co.companyId, { status: "todo", executionPolicy: null });

    const res = await checkoutAs(co, co.dispatcher, issue.body.id);
    expect(res.status).toBe(200);
    const row = await readIssue(issue.body.id);
    expect(row.assigneeAgentId).toBe(co.dispatcher);
    expect(row.executionPolicy).toBeNull();
    expect(row.leftIntakeAt).toBeNull();
  });

  it("rejects an explicit agent-terminal top-level policy at creation", async () => {
    const co = await seed();
    const res = await createTopLevel(co.companyId, {
      assigneeAgentId: co.dev,
      executionPolicy: { stages: [{ type: "approval", participants: [{ type: "agent", agentId: co.dispatcher }] }] },
    });
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "execution_policy_level_invariant" });
  });

  it("keeps today's behaviour when the company has no blueprint row", async () => {
    const co = await seed({ blueprint: false });
    const res = await createTopLevel(co.companyId, { assigneeAgentId: co.dev });
    expect(res.status).toBe(201);
    expect(res.body.executionPolicy ?? null).toBeNull();
    const review = await request(app(boardActor(co.companyId)))
      .patch(`/api/issues/${res.body.id}`)
      .send({ status: "in_review" });
    expect(review.status).toBe(200);
  });
});
