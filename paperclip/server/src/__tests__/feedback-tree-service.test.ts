import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  feedbackExports,
  feedbackVotes,
  issueComments,
  issues,
} from "@paperclipai/db";
import { feedbackService } from "../services/feedback.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres feedback tree tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
}

describeEmbeddedPostgres("feedbackService.listIssueTreeFeedback", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof feedbackService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-feedback-tree-");
    db = createDb(started.connectionString);
    svc = feedbackService(db);
    tempDb = started;
  }, 120_000);

  afterEach(async () => {
    await db.delete(feedbackExports);
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
      name: `${name}Coder`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssueWithAgentComment(input: {
    companyId: string;
    agentId: string;
    identifier: string;
    parentId?: string | null;
    body: string;
  }) {
    const issueId = randomUUID();
    const commentId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      parentId: input.parentId ?? null,
      identifier: input.identifier,
      title: `Issue ${input.identifier}`,
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId: input.companyId,
      issueId,
      authorAgentId: input.agentId,
      body: input.body,
    });
    return { issueId, commentId };
  }

  async function castVote(input: {
    companyId: string;
    issueId: string;
    commentId: string;
    vote: "up" | "down";
    reason?: string;
  }) {
    await db.insert(feedbackVotes).values({
      id: randomUUID(),
      companyId: input.companyId,
      issueId: input.issueId,
      targetType: "issue_comment",
      targetId: input.commentId,
      authorUserId: "board-user",
      vote: input.vote,
      reason: input.reason ?? null,
    });
  }

  it("collects downvotes and reasons across the whole descendant subtree", async () => {
    const { companyId, agentId } = await seedCompany("Alpha", "ALP");

    const parent = await seedIssueWithAgentComment({
      companyId,
      agentId,
      identifier: "TREE-1",
      body: "Parent comment body",
    });
    const child = await seedIssueWithAgentComment({
      companyId,
      agentId,
      identifier: "TREE-2",
      parentId: parent.issueId,
      body: "Child comment body",
    });
    const grandchild = await seedIssueWithAgentComment({
      companyId,
      agentId,
      identifier: "TREE-3",
      parentId: child.issueId,
      body: "Grandchild comment body",
    });
    // Sibling under the root that is NOT an ancestor of grandchild — still in subtree.
    const other = await seedIssueWithAgentComment({
      companyId,
      agentId,
      identifier: "TREE-9",
      body: "Unrelated root issue",
    });

    await castVote({ companyId, issueId: parent.issueId, commentId: parent.commentId, vote: "down", reason: "Parent is wrong" });
    await castVote({ companyId, issueId: child.issueId, commentId: child.commentId, vote: "up" });
    await castVote({ companyId, issueId: grandchild.issueId, commentId: grandchild.commentId, vote: "down", reason: "Grandchild bug" });
    await castVote({ companyId, issueId: other.issueId, commentId: other.commentId, vote: "down", reason: "Unrelated" });

    // A different company must never leak in.
    const otherCompany = await seedCompany("Beta", "BET");
    const betaIssue = await seedIssueWithAgentComment({
      companyId: otherCompany.companyId,
      agentId: otherCompany.agentId,
      identifier: "BET-1",
      body: "Beta comment body",
    });
    await castVote({
      companyId: otherCompany.companyId,
      issueId: betaIssue.issueId,
      commentId: betaIssue.commentId,
      vote: "down",
      reason: "Beta secret",
    });

    const feedback = await svc.listIssueTreeFeedback({ companyId, rootIssueId: parent.issueId });

    const byIssue = new Map(feedback.map((item) => [item.issueIdentifier, item]));

    expect(feedback).toHaveLength(3);
    expect([...byIssue.keys()].sort()).toEqual(["TREE-1", "TREE-2", "TREE-3"]);

    const parentItem = byIssue.get("TREE-1");
    expect(parentItem?.vote).toBe("down");
    expect(parentItem?.reason).toBe("Parent is wrong");
    expect(parentItem?.targetType).toBe("issue_comment");
    expect(parentItem?.target.excerpt).toContain("Parent comment body");
    expect(parentItem?.target.authorAgentId).toBe(agentId);

    const grandchildItem = byIssue.get("TREE-3");
    expect(grandchildItem?.vote).toBe("down");
    expect(grandchildItem?.reason).toBe("Grandchild bug");

    const childItem = byIssue.get("TREE-2");
    expect(childItem?.vote).toBe("up");
    expect(childItem?.reason).toBeNull();

    // Root-level sibling not under the parent is excluded; other company excluded.
    expect(byIssue.has("TREE-9")).toBe(false);
    expect(feedback.some((item) => item.reason === "Beta secret")).toBe(false);
  });

  it("limits to the root issue when includeSubtree is false", async () => {
    const { companyId, agentId } = await seedCompany("Gamma", "GAM");
    const parent = await seedIssueWithAgentComment({
      companyId,
      agentId,
      identifier: "SOLO-1",
      body: "Parent only",
    });
    const child = await seedIssueWithAgentComment({
      companyId,
      agentId,
      identifier: "SOLO-2",
      parentId: parent.issueId,
      body: "Child only",
    });
    await castVote({ companyId, issueId: parent.issueId, commentId: parent.commentId, vote: "down", reason: "root" });
    await castVote({ companyId, issueId: child.issueId, commentId: child.commentId, vote: "down", reason: "child" });

    const feedback = await svc.listIssueTreeFeedback({
      companyId,
      rootIssueId: parent.issueId,
      includeSubtree: false,
    });

    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.issueIdentifier).toBe("SOLO-1");
  });
});
