import { describe, expect, it } from "vitest";
import { classifyEdge, reconstructChain } from "../services/workflow-adherence.ts";

describe("workflow-adherence pure helpers", () => {
  const order = new Map<string, number>([
    ["data", 0], ["riker", 1], ["geordi", 2], ["hops", 3], ["worf", 4],
  ]);

  it("compresses consecutive duplicate holders", () => {
    const chain = reconstructChain([
      { agentId: "riker", t: 1 }, { agentId: "riker", t: 2 }, { agentId: "hops", t: 3 },
    ]);
    expect(chain.map((c) => c.agentId)).toEqual(["riker", "hops"]);
  });

  it("classifies adjacent forward, skip, backward, and offpath edges", () => {
    expect(classifyEdge("data", "riker", order)).toBe("forward");
    expect(classifyEdge("riker", "hops", order)).toBe("skip"); // skipped geordi
    expect(classifyEdge("hops", "riker", order)).toBe("backward");
    expect(classifyEdge("hops", "ghost", order)).toBe("offpath");
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll } from "vitest";
import { activityLog, agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { workflowAdherenceService } from "../services/workflow-adherence.ts";
import type { WorkflowBlueprint } from "@paperclipai/shared";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("workflowAdherenceService.compute", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wf-adherence-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterEach(async () => {
    await db.delete(activityLog); await db.delete(issues); await db.delete(agents); await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  it("counts a backward hop as rework and lowers adherence", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Co" });
    const riker = randomUUID(); const hops = randomUUID();
    await db.insert(agents).values([
      { id: riker, companyId, name: "Riker", role: "cto" },
      { id: hops, companyId, name: "Hops", role: "engineer" },
    ]);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, identifier: "ACME-1", title: "t", status: "done",
      completedAt: new Date(), createdAt: new Date(),
    });
    const base = Date.now();
    await db.insert(activityLog).values([
      { companyId, actorType: "agent", actorId: riker, action: "issue.checked_out", entityType: "issue", entityId: issueId, agentId: riker, createdAt: new Date(base) },
      { companyId, actorType: "agent", actorId: hops, action: "issue.checked_out", entityType: "issue", entityId: issueId, agentId: hops, createdAt: new Date(base + 1000) },
      { companyId, actorType: "agent", actorId: riker, action: "issue.checked_out", entityType: "issue", entityId: issueId, agentId: riker, createdAt: new Date(base + 2000) },
    ]);
    const blueprint: WorkflowBlueprint = {
      companyId, name: "x", updatedAt: null, returnEdges: [],
      stages: [
        { key: "plan", label: "Plan", position: 0, agentIds: [riker] },
        { key: "review", label: "Review", position: 1, agentIds: [hops] },
      ],
    };
    const result = await workflowAdherenceService(db).compute(companyId, blueprint);
    expect(result.ticketCount).toBe(1);
    expect(result.cleanTicketCount).toBe(0);
    const loop = result.reworkLoops.find((l) => l.fromAgentId === hops && l.toAgentId === riker);
    expect(loop?.count).toBe(1);
    expect(loop?.ticketCount).toBe(1);
  });
});
