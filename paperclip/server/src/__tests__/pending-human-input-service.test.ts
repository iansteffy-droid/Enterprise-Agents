import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  createDb,
  issueApprovals,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  pendingHumanInputService,
  presentApproval,
  presentInteraction,
} from "../services/pending-human-input.ts";

describe("presentApproval", () => {
  it("uses fixed Approve/Reject labels and resolves the message from the payload", () => {
    expect(presentApproval({ type: "hire_agent", payload: { message: "Hire Data?" } })).toEqual({
      message: "Hire Data?",
      acceptLabel: "Approve",
      rejectLabel: "Reject",
      canResolveInline: true,
    });
  });

  it("falls back through summary/title and finally to the approval type", () => {
    expect(presentApproval({ type: "budget_override", payload: { summary: "Raise cap" } }).message).toBe(
      "Raise cap",
    );
    expect(presentApproval({ type: "budget_override", payload: { title: "Cap" } }).message).toBe("Cap");
    expect(presentApproval({ type: "budget_override", payload: {} }).message).toBe(
      "budget_override approval",
    );
  });
});

describe("presentInteraction", () => {
  it("reads request_confirmation labels from the payload with confirm/decline defaults", () => {
    expect(
      presentInteraction({
        kind: "request_confirmation",
        payload: { prompt: "Is this plan good?", acceptLabel: "Approve plan", rejectLabel: "Send back" },
        title: null,
        summary: null,
      }),
    ).toEqual({
      message: "Is this plan good?",
      acceptLabel: "Approve plan",
      rejectLabel: "Send back",
      canResolveInline: true,
    });

    const defaults = presentInteraction({
      kind: "request_confirmation",
      payload: { prompt: "Ship it?" },
      title: null,
      summary: null,
    });
    expect(defaults.acceptLabel).toBe("Confirm");
    expect(defaults.rejectLabel).toBe("Decline");
  });

  it("uses checkbox-confirmation defaults and resolves on the ticket", () => {
    const result = presentInteraction({
      kind: "request_checkbox_confirmation",
      payload: { prompt: "Pick the ones to ship" },
      title: null,
      summary: null,
    });
    expect(result.acceptLabel).toBe("Confirm selected");
    expect(result.rejectLabel).toBe("Request changes");
    expect(result.canResolveInline).toBe(false);
  });

  it("uses the submit label for ask_user_questions and has no reject action", () => {
    const result = presentInteraction({
      kind: "ask_user_questions",
      payload: { title: "Which approach?", submitLabel: "Send answers" },
      title: null,
      summary: null,
    });
    expect(result.message).toBe("Which approach?");
    expect(result.acceptLabel).toBe("Send answers");
    expect(result.rejectLabel).toBeNull();
    expect(result.canResolveInline).toBe(false);
  });

  it("labels suggest_tasks from the row title and resolves on the ticket", () => {
    const result = presentInteraction({
      kind: "suggest_tasks",
      payload: { tasks: [] },
      title: "Break down the work",
      summary: null,
    });
    expect(result.message).toBe("Break down the work");
    expect(result.acceptLabel).toBe("Accept drafts");
    expect(result.canResolveInline).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pending-human-input tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pendingHumanInputService.list", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pending-human-input-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(issueThreadInteractions);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("merges pending approvals and interactions, joins agent + issue, and excludes resolved rows", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const approvalId = randomUUID();

    await db.insert(companies).values([
      { id: companyId, name: "Acme", issuePrefix: "ACM" },
      { id: otherCompanyId, name: "Other", issuePrefix: "OTH" },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Geordi",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ship the widget",
      identifier: "ACM-9",
      status: "in_progress",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
    });

    // Pending approval (created first) linked to the issue.
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "hire_agent",
      status: "pending",
      requestedByAgentId: agentId,
      payload: { message: "Approve the hire?" },
      createdAt: new Date("2026-07-02T00:00:00.000Z"),
      updatedAt: new Date("2026-07-02T00:00:00.000Z"),
    });
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId });

    // Pending confirmation (created later => should sort after the approval).
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      createdByAgentId: agentId,
      payload: { version: 1, prompt: "Is the ticket done?", acceptLabel: "Approve", rejectLabel: "Reject" },
      createdAt: new Date("2026-07-03T00:00:00.000Z"),
      updatedAt: new Date("2026-07-03T00:00:00.000Z"),
    });

    // Already-resolved interaction must be excluded.
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee",
      createdByAgentId: agentId,
      payload: { version: 1, prompt: "Old confirmation" },
      createdAt: new Date("2026-06-30T00:00:00.000Z"),
      updatedAt: new Date("2026-06-30T00:00:00.000Z"),
    });

    // Interaction in another company must be excluded.
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: otherCompanyId,
      title: "Not mine",
      status: "todo",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    await db.insert(issueThreadInteractions).values({
      companyId: otherCompanyId,
      issueId: otherIssueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Other company" },
      createdAt: new Date("2026-07-04T00:00:00.000Z"),
      updatedAt: new Date("2026-07-04T00:00:00.000Z"),
    });

    const items = await pendingHumanInputService(db).list(companyId);

    expect(items).toHaveLength(2);
    // Oldest-first: the approval was created before the confirmation.
    expect(items[0]).toMatchObject({
      source: "approval",
      kind: "approval",
      message: "Approve the hire?",
      acceptLabel: "Approve",
      rejectLabel: "Reject",
      canResolveInline: true,
      issue: { id: issueId, identifier: "ACM-9", title: "Ship the widget" },
      requestingAgent: { id: agentId, name: "Geordi", avatarUrl: null },
    });
    expect(items[1]).toMatchObject({
      source: "interaction",
      kind: "request_confirmation",
      message: "Is the ticket done?",
      acceptLabel: "Approve",
      rejectLabel: "Reject",
      canResolveInline: true,
      issue: { id: issueId, identifier: "ACM-9" },
    });
  });

  it("excludes requests raised on tickets that are done or cancelled", async () => {
    const companyId = randomUUID();
    const doneIssueId = randomUUID();
    const cancelledIssueId = randomUUID();
    const openIssueId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Acme", issuePrefix: "ACM" });
    await db.insert(issues).values([
      { id: doneIssueId, companyId, title: "Shipped", identifier: "ACM-1", status: "done" },
      { id: cancelledIssueId, companyId, title: "Abandoned", identifier: "ACM-2", status: "cancelled" },
      { id: openIssueId, companyId, title: "Still open", identifier: "ACM-3", status: "in_progress" },
    ]);

    // Pending interactions on closed tickets must be excluded; the open one stays.
    const interactionBase = {
      companyId,
      kind: "request_confirmation" as const,
      status: "pending" as const,
      continuationPolicy: "wake_assignee" as const,
    };
    await db.insert(issueThreadInteractions).values([
      { ...interactionBase, issueId: doneIssueId, payload: { version: 1, prompt: "On a done ticket" } },
      { ...interactionBase, issueId: cancelledIssueId, payload: { version: 1, prompt: "On a cancelled ticket" } },
      { ...interactionBase, issueId: openIssueId, payload: { version: 1, prompt: "On an open ticket" } },
    ]);

    // A pending approval linked only to a closed ticket dies with the ticket;
    // one linked to a closed AND an open ticket surfaces with the open one;
    // an unlinked approval (company-level gate) always stays.
    const closedOnlyApprovalId = randomUUID();
    const mixedApprovalId = randomUUID();
    const unlinkedApprovalId = randomUUID();
    const approvalBase = { companyId, type: "hire_agent", status: "pending" as const };
    await db.insert(approvals).values([
      { ...approvalBase, id: closedOnlyApprovalId, payload: { message: "Linked to done only" } },
      { ...approvalBase, id: mixedApprovalId, payload: { message: "Linked to done and open" } },
      { ...approvalBase, id: unlinkedApprovalId, payload: { message: "Unlinked gate" } },
    ]);
    await db.insert(issueApprovals).values([
      { companyId, issueId: doneIssueId, approvalId: closedOnlyApprovalId },
      { companyId, issueId: doneIssueId, approvalId: mixedApprovalId },
      { companyId, issueId: openIssueId, approvalId: mixedApprovalId },
    ]);

    const items = await pendingHumanInputService(db).list(companyId);
    const messages = items.map((item) => item.message);

    expect(messages).toContain("On an open ticket");
    expect(messages).toContain("Linked to done and open");
    expect(messages).toContain("Unlinked gate");
    expect(messages).not.toContain("On a done ticket");
    expect(messages).not.toContain("On a cancelled ticket");
    expect(messages).not.toContain("Linked to done only");

    const mixed = items.find((item) => item.id === mixedApprovalId);
    expect(mixed?.issue).toMatchObject({ id: openIssueId, identifier: "ACM-3" });
  });
});
