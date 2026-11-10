import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, routines, workflowBlueprints } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { workflowBlueprintService } from "../services/workflow-blueprint.ts";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("workflowBlueprintService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentA!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wf-blueprint-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workflowBlueprints);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co" });
    agentA = randomUUID();
    await db.insert(agents).values({ id: agentA, companyId, name: "Data", role: "pm" });
  }

  it("returns null when no blueprint saved", async () => {
    await seed();
    expect(await workflowBlueprintService(db).get(companyId)).toBeNull();
  });

  it("upserts and reads back a blueprint", async () => {
    await seed();
    const svc = workflowBlueprintService(db);
    const saved = await svc.upsert(companyId, {
      name: "The Perfect Run",
      stages: [{ key: "intake", label: "Intake", position: 0, agentIds: [agentA] }],
      returnEdges: [],
      createdByUserId: "local-board",
      createdByAgentId: null,
    });
    expect(saved.stages[0].agentIds).toEqual([agentA]);
    const again = await svc.get(companyId);
    expect(again?.name).toBe("The Perfect Run");
  });

  it("rejects agent ids not in the company", async () => {
    await seed();
    const foreign = randomUUID();
    await expect(
      workflowBlueprintService(db).upsert(companyId, {
        name: "x",
        stages: [{ key: "s", label: "S", position: 0, agentIds: [foreign] }],
        returnEdges: [],
        createdByUserId: "local-board",
        createdByAgentId: null,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  // ---- default chains ----------------------------------------------------

  const base = () => ({
    stages: [],
    returnEdges: [],
    createdByUserId: "local-board",
    createdByAgentId: null,
  });
  const review = (agentId: string) => ({
    type: "review" as const,
    approvalsNeeded: 1 as const,
    participants: [{ type: "agent" as const, agentId, userId: null }],
  });
  const approval = (userId = "board-user") => ({
    type: "approval" as const,
    approvalsNeeded: 1 as const,
    participants: [{ type: "user" as const, agentId: null, userId }],
  });

  it("stores and returns the default chains and settings", async () => {
    await seed();
    const svc = workflowBlueprintService(db);
    const routineId = randomUUID();
    await db.insert(routines).values({ id: routineId, companyId, title: "Prepare for merge" });
    const saved = await svc.upsert(companyId, {
      ...base(),
      mode: "strict",
      subtaskStages: [review(agentA)],
      featureStages: [review(agentA), approval()],
      haltPhrases: ["stop"],
      intakeAgentId: agentA,
      gatedSubtaskKinds: ["impl"],
      retro: { routineId, autoTrigger: true, bounceThreshold: 3, cooldownHours: 12 },
      prepareForMergeRoutineId: routineId,
    });
    expect(saved.mode).toBe("strict");
    expect(saved.subtaskStages).toHaveLength(1);
    expect(saved.featureStages).toHaveLength(2);
    const again = await svc.get(companyId);
    expect(again).toMatchObject({
      haltPhrases: ["stop"],
      intakeAgentId: agentA,
      gatedSubtaskKinds: ["impl"],
      retro: { routineId, autoTrigger: true, bounceThreshold: 3, cooldownHours: 12 },
      prepareForMergeRoutineId: routineId,
    });
  });

  it("leaves chains null and applies column defaults when none are supplied", async () => {
    await seed();
    const saved = await workflowBlueprintService(db).upsert(companyId, base());
    expect(saved).toMatchObject({
      mode: "standard",
      subtaskStages: null,
      featureStages: null,
      haltPhrases: null,
      intakeAgentId: null,
      gatedSubtaskKinds: ["impl", "tests"],
      retro: null,
      prepareForMergeRoutineId: null,
    });
  });

  it("keeps stored chains when a later save omits them and clears them on null", async () => {
    await seed();
    const svc = workflowBlueprintService(db);
    await svc.upsert(companyId, { ...base(), featureStages: [approval()] });
    expect((await svc.upsert(companyId, base())).featureStages).toHaveLength(1);
    expect((await svc.upsert(companyId, { ...base(), featureStages: null })).featureStages).toBeNull();
  });

  it("rejects a feature chain lacking a terminal user approval (422)", async () => {
    await seed();
    await expect(
      workflowBlueprintService(db).upsert(companyId, { ...base(), featureStages: [review(agentA)] }),
    ).rejects.toMatchObject({ status: 422, code: "execution_policy_level_invariant" });
  });

  it("rejects a subtask chain with a user participant (422)", async () => {
    await seed();
    await expect(
      workflowBlueprintService(db).upsert(companyId, { ...base(), subtaskStages: [review(agentA), approval()] }),
    ).rejects.toMatchObject({ status: 422, code: "execution_policy_level_invariant" });
  });

  it("rejects chains naming an agent outside the company", async () => {
    await seed();
    await expect(
      workflowBlueprintService(db).upsert(companyId, { ...base(), subtaskStages: [review(randomUUID())] }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects chains naming a paused agent", async () => {
    await seed();
    const paused = randomUUID();
    await db.insert(agents).values({ id: paused, companyId, name: "Paused", role: "engineer", status: "paused" });
    await expect(
      workflowBlueprintService(db).upsert(companyId, { ...base(), subtaskStages: [review(paused)] }),
    ).rejects.toMatchObject({ status: 422, code: "execution_policy_participant_not_invokable" });
  });

  it("rejects a chain that names the saving agent", async () => {
    await seed();
    await expect(
      workflowBlueprintService(db).upsert(companyId, {
        ...base(),
        createdByAgentId: agentA,
        subtaskStages: [review(agentA)],
      }),
    ).rejects.toMatchObject({ status: 422, code: "execution_policy_self_participant" });
  });

  it("persists templates with commentRequired forced true semantics (normalized, valid)", async () => {
    await seed();
    const saved = await workflowBlueprintService(db).upsert(companyId, {
      ...base(),
      subtaskStages: [review(agentA)],
    });
    // Templates are stored as bare stages (no policy wrapper), so there is no
    // commentRequired flag to flip; the policy built from them is always forced true.
    expect(saved.subtaskStages?.[0]).toMatchObject({ type: "review" });
    const { buildChainPolicy } = await import("../services/workflow-blueprint.ts");
    expect(buildChainPolicy(saved.subtaskStages!).commentRequired).toBe(true);
  });

  it("stores the cleaned templates (empty stage and duplicate participants dropped, no ids)", async () => {
    await seed();
    const saved = await workflowBlueprintService(db).upsert(companyId, {
      ...base(),
      featureStages: [
        { type: "review", approvalsNeeded: 1, participants: [] },
        {
          type: "approval",
          approvalsNeeded: 1,
          participants: [
            { id: randomUUID(), type: "user", agentId: null, userId: "board-user" },
            { id: randomUUID(), type: "user", agentId: null, userId: "board-user" },
          ],
        },
      ],
    });
    const expected = [
      {
        type: "approval",
        approvalsNeeded: 1,
        participants: [{ type: "user", agentId: null, userId: "board-user" }],
      },
    ];
    expect(saved.featureStages).toEqual(expected);
    expect((await workflowBlueprintService(db).get(companyId))?.featureStages).toEqual(expected);
  });

  it("rejects an intake agent, retro routine or merge routine outside the company", async () => {
    await seed();
    const svc = workflowBlueprintService(db);
    await expect(svc.upsert(companyId, { ...base(), intakeAgentId: randomUUID() })).rejects.toMatchObject({ status: 422 });
    const otherCompany = randomUUID();
    await db.insert(companies).values({ id: otherCompany, name: "Other", issuePrefix: "OTH" });
    const foreignRoutine = randomUUID();
    await db.insert(routines).values({ id: foreignRoutine, companyId: otherCompany, title: "Foreign" });
    await expect(svc.upsert(companyId, { ...base(), prepareForMergeRoutineId: foreignRoutine })).rejects.toMatchObject({
      status: 422,
      code: "workflow_routine_not_in_company",
    });
    await expect(
      svc.upsert(companyId, {
        ...base(),
        retro: { routineId: foreignRoutine, autoTrigger: false, bounceThreshold: 2, cooldownHours: 24 },
      }),
    ).rejects.toMatchObject({ status: 422, code: "workflow_routine_not_in_company" });
  });
});
