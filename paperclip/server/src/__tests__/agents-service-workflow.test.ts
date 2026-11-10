import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service workflowForCompany", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-workflow-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("derives the handoff graph from feature tickets the PM touched and excludes agents off the path", async () => {
    const companyId = randomUUID();
    const pmId = randomUUID();
    const eng1Id = randomUUID();
    const eng2Id = randomUUID();
    const barclayId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: pmId, companyId, name: "Data", role: "pm" },
      { id: eng1Id, companyId, name: "Eng One", role: "engineer" },
      { id: eng2Id, companyId, name: "Eng Two", role: "engineer" },
      { id: barclayId, companyId, name: "Barclay", role: "general" },
    ]);

    const featureParent = randomUUID();
    const featureChild = randomUUID();
    const nonFeature = randomUUID();
    const recent = new Date(Date.now() - 2 * 86_400_000); // 2 days ago -> near-max recency weight
    await db.insert(issues).values([
      { id: featureParent, companyId, title: "Feature A", createdByAgentId: pmId, completedAt: recent },
      { id: featureChild, companyId, title: "Feature A - subtask", parentId: featureParent, createdByAgentId: eng1Id },
      // A ticket the PM never touched (only Barclay) — must not feed the graph.
      { id: nonFeature, companyId, title: "Ops chore", createdByAgentId: barclayId },
    ]);

    const t = (offsetMs: number) => new Date(recent.getTime() + offsetMs);
    const touch = (entityId: string, agentId: string, at: Date) => ({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId,
      agentId,
      createdAt: at,
    });
    await db.insert(activityLog).values([
      // Parent: PM works then hands to Eng One.
      touch(featureParent, pmId, t(0)),
      touch(featureParent, eng1Id, t(1_000)),
      // Subtask: Eng One passes to Eng Two (dev -> dev handoff).
      touch(featureChild, eng1Id, t(2_000)),
      touch(featureChild, eng2Id, t(3_000)),
      // Barclay only ever touches the non-feature ticket.
      touch(nonFeature, barclayId, t(4_000)),
    ]);

    // A reviewer who only appears in the comment thread (never in activity_log)
    // must still be captured as a downstream handoff.
    const reviewerId = randomUUID();
    await db.insert(agents).values({ id: reviewerId, companyId, name: "Reviewer", role: "engineer" });
    await db.insert(issueComments).values({
      companyId,
      issueId: featureChild,
      authorAgentId: reviewerId,
      body: "Reviewed and approved.",
      createdAt: t(3_500),
    });

    const svc = agentService(db);
    const graph = await svc.workflowForCompany(companyId);

    const nodeIds = new Set(graph.nodes.map((n) => n.agentId));
    expect(nodeIds).toEqual(new Set([pmId, eng1Id, eng2Id, reviewerId]));
    expect(nodeIds.has(barclayId)).toBe(false);

    const edgeIds = new Set(graph.edges.map((e) => e.id));
    expect(edgeIds.has(`${pmId}->${eng1Id}`)).toBe(true);
    expect(edgeIds.has(`${eng1Id}->${eng2Id}`)).toBe(true);
    // Handoff derived purely from the comment thread:
    expect(edgeIds.has(`${eng2Id}->${reviewerId}`)).toBe(true);

    // Each edge carries a raw interaction count for the hover hint.
    const pmToEng1 = graph.edges.find((e) => e.id === `${pmId}->${eng1Id}`)!;
    expect(pmToEng1.count).toBeGreaterThanOrEqual(1);

    // PM is the origin of the flow; Eng Two is downstream.
    const stage = (id: string) => graph.nodes.find((n) => n.agentId === id)!.avgStage;
    expect(stage(pmId)).toBeLessThan(stage(eng2Id));

    expect(graph.meta.ticketCount).toBe(1);
  });

  it("returns an empty graph when the company has no PM", async () => {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "No PM Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([{ id: randomUUID(), companyId, name: "Solo", role: "engineer" }]);

    const svc = agentService(db);
    const graph = await svc.workflowForCompany(companyId);
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });
});
