import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  feedbackExports,
  feedbackVotes,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  issueComments,
  issues,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { collectDownvoteFailures } from "./downvotes.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping downvote collector DB tests: ${support.reason ?? "unsupported host"}`);
}

describeDb("collectDownvoteFailures", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-evals-downvotes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("harvests agent-authored downvotes and ignores up-votes, user comments, and doc-revision votes", async () => {
    const [company] = await db
      .insert(companies)
      .values({ name: "Co", description: "d", status: "active", budgetMonthlyCents: 1000 })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: "Engineer",
        role: "engineer",
        title: "Engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "echo", args: ["hi"] },
        budgetMonthlyCents: 500,
      })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({ companyId: company!.id, title: "Task", status: "done" })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId: company!.id, agentId: agent!.id })
      .returning();

    // Agent-authored comment that gets a downvote -> should be harvested.
    const [agentComment] = await db
      .insert(issueComments)
      .values({
        companyId: company!.id,
        issueId: issue!.id,
        authorAgentId: agent!.id,
        authorType: "agent",
        createdByRunId: run!.id,
        body: "Done, shipped it.",
      })
      .returning();
    const [downVote] = await db
      .insert(feedbackVotes)
      .values({
        companyId: company!.id,
        issueId: issue!.id,
        targetType: "issue_comment",
        targetId: agentComment!.id,
        authorUserId: "user-1",
        vote: "down",
        reason: "Did not actually ship.",
      })
      .returning();
    await db.insert(feedbackExports).values({
      companyId: company!.id,
      feedbackVoteId: downVote!.id,
      issueId: issue!.id,
      authorUserId: "user-1",
      targetType: "issue_comment",
      targetId: agentComment!.id,
      vote: "down",
      exportId: "fbexp_abc123",
      targetSummary: {},
    });

    // Up-vote -> ignored.
    const [goodComment] = await db
      .insert(issueComments)
      .values({
        companyId: company!.id,
        issueId: issue!.id,
        authorAgentId: agent!.id,
        authorType: "agent",
        createdByRunId: run!.id,
        body: "Great work reference.",
      })
      .returning();
    await db.insert(feedbackVotes).values({
      companyId: company!.id,
      issueId: issue!.id,
      targetType: "issue_comment",
      targetId: goodComment!.id,
      authorUserId: "user-1",
      vote: "up",
    });

    // Downvote on a USER-authored comment (no agent) -> ignored.
    const [userComment] = await db
      .insert(issueComments)
      .values({
        companyId: company!.id,
        issueId: issue!.id,
        authorUserId: "user-2",
        authorType: "user",
        body: "A human note.",
      })
      .returning();
    await db.insert(feedbackVotes).values({
      companyId: company!.id,
      issueId: issue!.id,
      targetType: "issue_comment",
      targetId: userComment!.id,
      authorUserId: "user-1",
      vote: "down",
      reason: "n/a",
    });

    // Downvote on a doc revision -> out of scope, ignored.
    await db.insert(feedbackVotes).values({
      companyId: company!.id,
      issueId: issue!.id,
      targetType: "issue_document_revision",
      targetId: "00000000-0000-0000-0000-000000000000",
      authorUserId: "user-1",
      vote: "down",
      reason: "doc bad",
    });

    const entries = await collectDownvoteFailures(db, company!.id);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: `downvote:${downVote!.id}`,
      agentId: agent!.id,
      agentName: "Engineer",
      signalType: "downvote",
      issueId: issue!.id,
      runId: run!.id,
      reason: "Did not actually ship.",
      traceRef: "fbexp_abc123",
      status: "new",
    });
    expect(typeof entries[0]!.detectedAt).toBe("string");
  });
});
