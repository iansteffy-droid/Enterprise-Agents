import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  feedbackVotes,
  issueComments,
  issues,
  retroPointStatus,
} from "@paperclipai/db";
import { retroPointsService } from "../services/retro-points.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres retro points tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
}

function retroBody(reviewed: string, score: number, proposals: Array<[number, string, string, number, number]>): string {
  const rows = proposals
    .map(([n, change, file, impact, effort]) => `| ${n} | ${change} | ${file} | ${impact} | ${effort} |`)
    .join("\n");
  return [
    `## Crew retrospective — ${reviewed} (operator score: ${score}/10)`,
    "",
    `**Operator feedback:** "Feedback for ${reviewed}."`,
    "",
    "**Root causes:**",
    `Why ${reviewed} went the way it did.`,
    "",
    "| # | Change | Target file | Impact /10 | Effort /10 |",
    "| - | ------ | ----------- | ---------- | ---------- |",
    rows,
    "",
    "**Next step:** operator applies.",
  ].join("\n");
}

describeEmbeddedPostgres("retroPointsService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof retroPointsService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-retro-points-");
    db = createDb(started.connectionString);
    svc = retroPointsService(db);
    tempDb = started;
  }, 120_000);

  afterEach(async () => {
    await db.delete(retroPointStatus);
    await db.delete(feedbackVotes);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string, prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${name}Facilitator`,
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(input: {
    companyId: string;
    identifier: string;
    title: string;
    createdAt?: Date;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
      createdAt: input.createdAt ?? new Date(),
    });
    return id;
  }

  async function seedRetroComment(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    body: string;
  }) {
    const id = randomUUID();
    await db.insert(issueComments).values({
      id,
      companyId: input.companyId,
      issueId: input.issueId,
      authorAgentId: input.agentId,
      body: input.body,
    });
    return id;
  }

  it("ranks proposals by default priority (impact - 0.5*effort) and resolves reviewed tickets", async () => {
    const { companyId, agentId } = await seedCompany("Alpha", "ALP");

    // The reviewed feature ticket the retro references (not the retro ticket itself).
    await seedIssue({ companyId, identifier: "ALP-100", title: "Login rework" });

    const retroId = await seedIssue({
      companyId,
      identifier: "ALP-900",
      title: "Crew retrospective — ALP-100",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await seedRetroComment({
      companyId,
      issueId: retroId,
      agentId,
      body: retroBody("ALP-100", 7, [
        // priority = impact - 0.5*effort
        [1, "Low priority change", "a.ts", 3, 6], // 0.0
        [2, "High impact low effort", "b.ts", 9, 2], // 8.0
        [3, "Medium change", "c.ts", 6, 2], // 5.0
      ]),
    });

    const points = await svc.listRetroPoints(companyId);
    expect(points).toHaveLength(3);

    // Ranked highest priority first.
    expect(points.map((p) => p.number)).toEqual([2, 3, 1]);
    expect(points[0]).toMatchObject({
      number: 2,
      impact: 9,
      effort: 2,
      priority: 8,
      pointKey: `${retroId}_2`,
      retroIdentifier: "ALP-900",
      reviewedIdentifier: "ALP-100",
      reviewedTitle: "Login rework",
      status: "open", // never recorded → open
    });
    expect(points[0]?.reviewedIssueId).not.toBeNull();

    // "Why" context is carried through.
    expect(points[0]?.why.score).toBe(7);
    expect(points[0]?.why.operatorFeedback).toContain("Feedback for ALP-100");
    expect(points[0]?.why.rootCauses).toContain("Why ALP-100 went");
  });

  it("joins stored operator status onto the matching point key and surfaces downvote reasons", async () => {
    const { companyId, agentId } = await seedCompany("Beta", "BET");
    const retroId = await seedIssue({
      companyId,
      identifier: "BET-900",
      title: "Crew retrospective — BET-100",
    });
    const commentId = await seedRetroComment({
      companyId,
      issueId: retroId,
      agentId,
      body: retroBody("BET-100", 5, [
        [1, "Change one", "x.ts", 8, 2],
        [2, "Change two", "y.ts", 4, 1],
      ]),
    });

    // Operator set status on proposal #1 only.
    await svc.setRetroPointStatus({
      companyId,
      pointKey: `${retroId}_1`,
      status: "merged",
      note: "picked up",
      updatedByUserId: "board-user",
    });

    // An operator down-vote with a reason on the retro's authoring comment.
    await db.insert(feedbackVotes).values({
      id: randomUUID(),
      companyId,
      issueId: retroId,
      targetType: "issue_comment",
      targetId: commentId,
      authorUserId: "board-user",
      vote: "down",
      reason: "This retro missed the real cause",
    });

    const points = await svc.listRetroPoints(companyId);
    const byKey = new Map(points.map((p) => [p.pointKey, p]));

    const p1 = byKey.get(`${retroId}_1`);
    expect(p1?.status).toBe("merged");
    expect(p1?.note).toBe("picked up");
    expect(p1?.updatedAt).not.toBeNull();

    const p2 = byKey.get(`${retroId}_2`);
    expect(p2?.status).toBe("open");
    expect(p2?.note).toBeNull();

    // Downvote reasons attach to every point derived from that comment.
    expect(p1?.why.downvoteReasons).toEqual(["This retro missed the real cause"]);
    expect(p2?.why.downvoteReasons).toEqual(["This retro missed the real cause"]);
  });

  async function seedRetro(companyId: string, agentId: string, identifier: string, reviewed: string) {
    const retroId = await seedIssue({ companyId, identifier, title: `Crew retrospective — ${reviewed}` });
    await seedRetroComment({
      companyId,
      issueId: retroId,
      agentId,
      body: retroBody(reviewed, 6, [[1, "Change one", "x.ts", 6, 2]]),
    });
    return retroId;
  }

  it("upsert: a second setRetroPointStatus updates the same row rather than duplicating", async () => {
    const { companyId, agentId } = await seedCompany("Gamma", "GAM");
    const retroId = await seedRetro(companyId, agentId, "GAM-900", "GAM-1");
    const first = await svc.setRetroPointStatus({
      companyId,
      pointKey: `${retroId}_1`,
      status: "open",
      updatedByUserId: "board-user",
    });
    const second = await svc.setRetroPointStatus({
      companyId,
      pointKey: `${retroId}_1`,
      status: "rejected",
      note: "not worth it",
      updatedByUserId: "board-user-2",
    });
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("rejected");
    expect(second.note).toBe("not worth it");

    const rows = await db
      .select()
      .from(retroPointStatus)
      .where(eq(retroPointStatus.companyId, companyId));
    expect(rows).toHaveLength(1);
  });

  it("round-trips proposalRef set by an agent and keeps it when the board later sets the status", async () => {
    const { companyId, agentId } = await seedCompany("Delta", "DEL");
    const retroId = await seedRetro(companyId, agentId, "DEL-900", "DEL-1");
    const pointKey = `${retroId}_1`;

    // Before anything is recorded: open by default, no reference.
    const [initial] = await svc.listRetroPoints(companyId);
    expect(initial).toMatchObject({ pointKey, status: "open", proposalRef: null });

    const prUrl = "https://github.com/example/kit/pull/12";
    const recorded = await svc.setRetroPointStatus({
      companyId,
      pointKey,
      status: "open",
      proposalRef: prUrl,
      updatedByAgentId: agentId,
    });
    expect(recorded).toMatchObject({
      status: "open",
      proposalRef: prUrl,
      updatedByAgentId: agentId,
      updatedByUserId: null,
    });

    const [afterAgent] = await svc.listRetroPoints(companyId);
    expect(afterAgent).toMatchObject({ pointKey, status: "open", proposalRef: prUrl });

    // The human marks it merged without resending the reference: the reference stays.
    await svc.setRetroPointStatus({ companyId, pointKey, status: "merged", updatedByUserId: "board-user" });
    const [afterBoard] = await svc.listRetroPoints(companyId);
    expect(afterBoard).toMatchObject({ status: "merged", proposalRef: prUrl });

    // A branch reference (no remote yet), then an explicit clear.
    await svc.setRetroPointStatus({ companyId, pointKey, proposalRef: "branch:retro/DEL-1", updatedByAgentId: agentId });
    expect((await svc.listRetroPoints(companyId))[0]).toMatchObject({
      status: "merged",
      proposalRef: "branch:retro/DEL-1",
    });
    await svc.setRetroPointStatus({ companyId, pointKey, proposalRef: null, updatedByUserId: "board-user" });
    expect((await svc.listRetroPoints(companyId))[0]?.proposalRef).toBeNull();
  });

  it("a first write with only a proposalRef stores the point as open", async () => {
    const { companyId, agentId } = await seedCompany("Eps", "EPS");
    const retroId = await seedRetro(companyId, agentId, "EPS-900", "EPS-1");
    const row = await svc.setRetroPointStatus({
      companyId,
      pointKey: `${retroId}_1`,
      proposalRef: "branch:retro/EPS-1",
      updatedByAgentId: agentId,
    });
    expect(row).toMatchObject({ status: "open", proposalRef: "branch:retro/EPS-1" });
  });

  it.each(["done", "in_progress", "closed"])("rejects status %s with 422", async (status) => {
    const { companyId, agentId } = await seedCompany("Zeta", "ZET");
    const retroId = await seedRetro(companyId, agentId, "ZET-900", "ZET-1");
    await expect(
      svc.setRetroPointStatus({ companyId, pointKey: `${retroId}_1`, status, updatedByUserId: "u" }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it.each(["not a reference", "branch:", "ftp://example.com/pr/1", ""])(
    "rejects proposalRef %j that is neither a PR URL nor branch:<name> with 422",
    async (proposalRef) => {
      const { companyId, agentId } = await seedCompany("Eta", "ETA");
      const retroId = await seedRetro(companyId, agentId, "ETA-900", "ETA-1");
      await expect(
        svc.setRetroPointStatus({ companyId, pointKey: `${retroId}_1`, proposalRef, updatedByAgentId: agentId }),
      ).rejects.toMatchObject({ status: 422 });
    },
  );

  it("is company-scoped: a point of another company's retro is 404 and nothing is stored", async () => {
    const alpha = await seedCompany("Theta", "THE");
    const beta = await seedCompany("Iota", "IOT");
    const betaRetro = await seedRetro(beta.companyId, beta.agentId, "IOT-900", "IOT-1");

    await expect(
      svc.setRetroPointStatus({
        companyId: alpha.companyId,
        pointKey: `${betaRetro}_1`,
        status: "open",
        proposalRef: "branch:retro/IOT-1",
        updatedByAgentId: alpha.agentId,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.setRetroPointStatus({
        companyId: alpha.companyId,
        pointKey: "not-a-point-key",
        status: "open",
        updatedByAgentId: alpha.agentId,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(retroPointStatus)).toHaveLength(0);
  });

  it("parses the facilitator's comment format, including root cause and scope columns", async () => {
    const { companyId, agentId } = await seedCompany("Kappa", "KAP");
    const retroId = await seedIssue({ companyId, identifier: "KAP-900", title: "Crew retrospective — KAP-5" });
    await seedIssue({ companyId, identifier: "KAP-5", title: "Export feature" });
    await seedRetroComment({
      companyId,
      issueId: retroId,
      agentId,
      body: [
        "## Crew retrospective — KAP-5 + 2 subtasks (operator score: unscored (auto: bounce_threshold))",
        "**Operator feedback:** none given",
        "### Part 2 — Efficiency (from retro-metrics)",
        "| Agent | runs | failed/timed out | bounces caught | bounces caused | approvals with findings | cost | wasted wakes |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| Dev | 4 | 1 | 0 | 2 | 0 | $1.20 | 1 |",
        "### Part 4 — Proposals",
        "| # | Change | Target file | Impact /10 | Effort /10 | Root cause | Scope |",
        "| - | ------ | ----------- | ---------- | ---------- | ---------- | ----- |",
        "| 1 | Dev runs the linter before hand-off | agents/dev/AGENTS.md | 7 | 1 | lint skipped twice | universal |",
        "### Part 5 — Where the proposals are",
        "branch:retro/KAP-5",
      ].join("\n"),
    });

    const points = await svc.listRetroPoints(companyId);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      number: 1,
      change: "Dev runs the linter before hand-off",
      targetFile: "agents/dev/AGENTS.md",
      impact: 7,
      effort: 1,
      scope: "universal",
      reviewedIdentifier: "KAP-5",
      reviewedTitle: "Export feature",
    });
    expect(points[0]?.why.rootCauses).toBe("lint skipped twice");
    expect(points[0]?.why.score).toBeNull();
  });

  it("keeps pointKeys unique when a comment repeats a row number, and the suffixed point is writable", async () => {
    const { companyId, agentId } = await seedCompany("Lambda", "LAM");
    const retroId = await seedIssue({ companyId, identifier: "LAM-900", title: "Crew retrospective — LAM-1" });
    await seedRetroComment({
      companyId,
      issueId: retroId,
      agentId,
      body: retroBody("LAM-1", 6, [
        [1, "First", "a.ts", 5, 1],
        [1, "Duplicate number", "b.ts", 4, 1],
        [2, "Second", "c.ts", 3, 1],
      ]),
    });

    const points = await svc.listRetroPoints(companyId);
    const keys = points.map((p) => p.pointKey).sort();
    expect(keys).toEqual([`${retroId}_1`, `${retroId}_1.2`, `${retroId}_2`].sort());
    expect(new Set(keys).size).toBe(3);
    expect(points.find((p) => p.change === "Duplicate number")?.pointKey).toBe(`${retroId}_1.2`);

    await svc.setRetroPointStatus({ companyId, pointKey: `${retroId}_1.2`, status: "rejected", updatedByUserId: "u" });
    const after = await svc.listRetroPoints(companyId);
    expect(after.find((p) => p.pointKey === `${retroId}_1.2`)?.status).toBe("rejected");
    expect(after.find((p) => p.pointKey === `${retroId}_1`)?.status).toBe("open");
  });

  it("does not leak another company's retros", async () => {
    const alpha = await seedCompany("A", "AAA");
    const beta = await seedCompany("B", "BBB");
    const alphaRetro = await seedIssue({ companyId: alpha.companyId, identifier: "AAA-900", title: "Crew retrospective — AAA-1" });
    await seedRetroComment({
      companyId: alpha.companyId,
      issueId: alphaRetro,
      agentId: alpha.agentId,
      body: retroBody("AAA-1", 8, [[1, "Alpha change", "a.ts", 5, 2]]),
    });
    const betaRetro = await seedIssue({ companyId: beta.companyId, identifier: "BBB-900", title: "Crew retrospective — BBB-1" });
    await seedRetroComment({
      companyId: beta.companyId,
      issueId: betaRetro,
      agentId: beta.agentId,
      body: retroBody("BBB-1", 8, [[1, "Beta secret change", "b.ts", 5, 2]]),
    });

    const alphaPoints = await svc.listRetroPoints(alpha.companyId);
    expect(alphaPoints).toHaveLength(1);
    expect(alphaPoints[0]?.change).toBe("Alpha change");
    expect(alphaPoints.some((p) => p.change.includes("Beta"))).toBe(false);
  });
});
