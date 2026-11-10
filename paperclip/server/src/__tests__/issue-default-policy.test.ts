import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, workflowBlueprints } from "@paperclipai/db";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  issueKindsFromLabels,
  replaceExecutionChain,
  resolveIssueExecutionPolicy,
  type ResolvePolicyInput,
} from "../services/issue-default-policy.ts";

describe("issueKindsFromLabels", () => {
  it("treats a subtask without a kind label as impl", () => {
    expect(issueKindsFromLabels([])).toEqual(["impl"]);
    expect(issueKindsFromLabels(["bug", "frontend"])).toEqual(["impl"]);
  });

  it("reads kind:impl, kind:tests and kind:repro exactly", () => {
    expect(issueKindsFromLabels(["kind:repro"])).toEqual(["repro"]);
    expect(issueKindsFromLabels(["bug", "kind:tests"])).toEqual(["tests"]);
    expect(issueKindsFromLabels(["kind:impl", "kind:tests", "kind:impl"])).toEqual(["impl", "tests"]);
  });

  it("is case-sensitive and ignores unknown kinds", () => {
    expect(issueKindsFromLabels(["Kind:repro"])).toEqual(["impl"]);
    expect(issueKindsFromLabels(["kind:REPRO"])).toEqual(["impl"]);
    expect(issueKindsFromLabels(["kind:docs"])).toEqual(["impl"]);
    expect(issueKindsFromLabels([" kind:repro"])).toEqual(["impl"]);
  });
});

describe("replaceExecutionChain", () => {
  const stage = (type: "review" | "approval") => ({
    id: randomUUID(),
    type,
    approvalsNeeded: 1 as const,
    participants: [{ id: randomUUID(), type: "user" as const, agentId: null, userId: "board-user-1" }],
  });
  const monitor = {
    nextCheckAt: "2026-11-10T00:00:00.000Z",
    notes: null,
    scheduledBy: "board" as const,
  } as unknown as NonNullable<IssueExecutionPolicy["monitor"]>;

  it("swaps the stages and keeps the monitor", () => {
    const base: IssueExecutionPolicy = { mode: "normal", commentRequired: false, stages: [stage("review")], monitor };
    const chain: IssueExecutionPolicy = { mode: "normal", commentRequired: true, stages: [stage("approval")] };
    expect(replaceExecutionChain(base, chain)).toEqual({ ...base, commentRequired: true, stages: chain.stages });
  });

  it("returns null when removing the chain leaves nothing", () => {
    expect(replaceExecutionChain({ mode: "normal", commentRequired: true, stages: [stage("review")] }, null)).toBeNull();
    expect(replaceExecutionChain(null, null)).toBeNull();
  });

  it("keeps a monitor-only policy when the chain is removed", () => {
    const base: IssueExecutionPolicy = { mode: "normal", commentRequired: true, stages: [stage("review")], monitor };
    expect(replaceExecutionChain(base, null)).toEqual({ ...base, stages: [] });
  });
});

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("resolveIssueExecutionPolicy", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let intakeAgentId!: string;
  let dispatcherAgentId!: string;
  let qaAgentId!: string;
  let reviewerAgentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-default-policy-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workflowBlueprints);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(options: { blueprint?: boolean } = {}) {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co" });
    intakeAgentId = randomUUID();
    dispatcherAgentId = randomUUID();
    qaAgentId = randomUUID();
    reviewerAgentId = randomUUID();
    await db.insert(agents).values([
      { id: intakeAgentId, companyId, name: "Intake", role: "pm" },
      { id: dispatcherAgentId, companyId, name: "Dispatcher", role: "pm" },
      { id: qaAgentId, companyId, name: "QA", role: "qa" },
      { id: reviewerAgentId, companyId, name: "Reviewer", role: "engineer" },
    ]);
    if (options.blueprint === false) return;
    await db.insert(workflowBlueprints).values({
      companyId,
      intakeAgentId,
      subtaskStages: [
        { type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: reviewerAgentId, userId: null }] },
      ],
      featureStages: [
        { type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: qaAgentId, userId: null }] },
        { type: "approval", approvalsNeeded: 1, participants: [{ type: "user", agentId: null, userId: "board-user-1" }] },
      ],
    });
  }

  function input(overrides: Partial<ResolvePolicyInput> = {}): ResolvePolicyInput {
    return {
      companyId,
      parentId: null,
      explicitPolicy: null,
      explicitNull: false,
      assigneeAgentId: dispatcherAgentId,
      originKind: "manual",
      labelNames: [],
      actor: { type: "user", agentId: null },
      ...overrides,
    };
  }

  function buildFeaturePolicy(): IssueExecutionPolicy {
    return {
      mode: "normal",
      commentRequired: true,
      stages: [
        {
          id: randomUUID(),
          type: "approval",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "user", agentId: null, userId: "board-user-1" }],
        },
      ],
    };
  }

  function agentTerminalPolicy(agentId: string): IssueExecutionPolicy {
    return {
      mode: "normal",
      commentRequired: true,
      stages: [
        {
          id: randomUUID(),
          type: "approval",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId, userId: null }],
        },
      ],
    };
  }

  it("returns the top-level template with fresh stage ids for parentId=null", async () => {
    await seed();
    const first = await resolveIssueExecutionPolicy(db, input());
    const second = await resolveIssueExecutionPolicy(db, input());
    expect(first.source).toBe("default");
    expect(first.leftIntake).toBe(true);
    expect(first.policy?.commentRequired).toBe(true);
    expect(first.policy?.stages.map((stage) => stage.type)).toEqual(["review", "approval"]);
    expect(first.policy?.stages[0]!.participants[0]).toMatchObject({ type: "agent", agentId: qaAgentId });
    expect(first.policy?.stages[0]!.id).toEqual(expect.any(String));
    expect(first.policy?.stages[0]!.id).not.toBe(second.policy?.stages[0]!.id);
    expect(first.policy?.stages[0]!.participants[0]!.id).not.toBe(second.policy?.stages[0]!.participants[0]!.id);
  });

  it("attaches no top-level chain while the issue is in intake", async () => {
    await seed();
    for (const assigneeAgentId of [null, intakeAgentId]) {
      const resolved = await resolveIssueExecutionPolicy(db, input({ assigneeAgentId }));
      expect(resolved).toEqual({ policy: null, source: "none", leftIntake: false, boardUngated: false });
    }
  });

  it("treats any agent assignee as leaving intake when no intake agent is configured", async () => {
    await seed();
    await db.update(workflowBlueprints).set({ intakeAgentId: null });
    const resolved = await resolveIssueExecutionPolicy(db, input({ assigneeAgentId: intakeAgentId }));
    expect(resolved.source).toBe("default");
    expect(resolved.leftIntake).toBe(true);
  });

  it("returns the subtask template for a child", async () => {
    await seed();
    const resolved = await resolveIssueExecutionPolicy(db, input({ parentId: randomUUID(), assigneeAgentId: null }));
    expect(resolved.source).toBe("default");
    expect(resolved.leftIntake).toBe(false);
    expect(resolved.policy?.stages).toHaveLength(1);
    expect(resolved.policy?.stages[0]!.participants[0]).toMatchObject({ type: "agent", agentId: reviewerAgentId });
  });

  it("attaches no subtask chain when the kind label is not gated", async () => {
    await seed();
    const repro = await resolveIssueExecutionPolicy(
      db,
      input({ parentId: randomUUID(), labelNames: ["kind:repro"] }),
    );
    expect(repro.policy).toBeNull();
    const tests = await resolveIssueExecutionPolicy(
      db,
      input({ parentId: randomUUID(), labelNames: ["kind:tests"] }),
    );
    expect(tests.source).toBe("default");
  });

  it("ignores an agent's explicit null and still applies the default", async () => {
    await seed();
    const resolved = await resolveIssueExecutionPolicy(
      db,
      input({ explicitNull: true, actor: { type: "agent", agentId: intakeAgentId } }),
    );
    expect(resolved.source).toBe("default");
    expect(resolved.policy?.stages).toHaveLength(2);
  });

  it("honours a board user's explicit null", async () => {
    await seed();
    const resolved = await resolveIssueExecutionPolicy(db, input({ explicitNull: true }));
    expect(resolved).toEqual({ policy: null, source: "none", leftIntake: false, boardUngated: true });
  });

  it("attaches no default to an issue a board user ungated earlier, but keeps an explicit policy", async () => {
    await seed();
    expect(await resolveIssueExecutionPolicy(db, input({ ungated: true }))).toEqual({
      policy: null,
      source: "none",
      leftIntake: false,
      boardUngated: false,
    });
    expect((await resolveIssueExecutionPolicy(db, input({ parentId: randomUUID(), ungated: true }))).policy).toBeNull();
    const explicit = await resolveIssueExecutionPolicy(
      db,
      input({ ungated: true, explicitPolicy: buildFeaturePolicy() }),
    );
    expect(explicit.source).toBe("explicit");
  });

  it("skips routine_execution issues", async () => {
    await seed();
    expect((await resolveIssueExecutionPolicy(db, input({ originKind: "routine_execution" }))).policy).toBeNull();
    expect(
      (await resolveIssueExecutionPolicy(db, input({ parentId: randomUUID(), originKind: "routine_execution" }))).policy,
    ).toBeNull();
  });

  it("rejects an explicit agent-terminal top-level policy with execution_policy_level_invariant", async () => {
    await seed();
    await expect(
      resolveIssueExecutionPolicy(db, input({ explicitPolicy: agentTerminalPolicy(qaAgentId) })),
    ).rejects.toMatchObject({ status: 422, details: { code: "execution_policy_level_invariant" } });
  });

  it("rejects an explicit policy naming the creating agent with execution_policy_self_participant", async () => {
    await seed();
    const policy: IssueExecutionPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [
        {
          id: randomUUID(),
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: dispatcherAgentId, userId: null }],
        },
      ],
    };
    await expect(
      resolveIssueExecutionPolicy(
        db,
        input({ parentId: randomUUID(), explicitPolicy: policy, actor: { type: "agent", agentId: dispatcherAgentId } }),
      ),
    ).rejects.toMatchObject({ status: 422, details: { code: "execution_policy_self_participant" } });
  });

  it("returns a valid explicit policy unchanged", async () => {
    await seed();
    const policy: IssueExecutionPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [
        {
          id: randomUUID(),
          type: "approval",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "user", agentId: null, userId: "board-user-1" }],
        },
      ],
    };
    const resolved = await resolveIssueExecutionPolicy(db, input({ explicitPolicy: policy }));
    expect(resolved).toEqual({ policy, source: "explicit", leftIntake: true, boardUngated: false });
  });

  it("returns null when no blueprint exists", async () => {
    await seed({ blueprint: false });
    expect(await resolveIssueExecutionPolicy(db, input())).toEqual({
      policy: null,
      source: "none",
      leftIntake: false,
      boardUngated: false,
    });
    // Without a blueprint row an explicit policy is today's behaviour: kept, not level-checked.
    const policy = agentTerminalPolicy(qaAgentId);
    expect((await resolveIssueExecutionPolicy(db, input({ explicitPolicy: policy }))).policy).toBe(policy);
  });
});
