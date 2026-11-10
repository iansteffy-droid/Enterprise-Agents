// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { Issue, IssueExecutionState } from "@paperclipai/shared";
import { InboxIssueMetaLeading, InboxIssueTrailingColumns } from "./IssueColumns";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void): void {
  flushSync(callback);
}

function makeIssue(overrides: Partial<Issue>): Issue {
  return {
    id: "issue-id",
    identifier: "PAP-1",
    status: "in_progress",
    blockerAttention: false,
    ...overrides,
  } as unknown as Issue;
}

// Fills the required IssueExecutionState fields so callers only specify the
// parts a test cares about, keeping the mocks type-safe as the type grows.
function makeExecutionState(overrides: Partial<IssueExecutionState>): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

function renderLeading(element: React.ReactElement): string {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(element));
  return container.textContent ?? "";
}

describe("InboxIssueMetaLeading live state", () => {
  it("shows the own Live chip for a running issue and never the subtree chip", () => {
    const text = renderLeading(
      <InboxIssueMetaLeading
        issue={makeIssue({ id: "child", identifier: "PAP-2", status: "in_progress" })}
        isLive
        subtreeLiveCount={3}
      />,
    );
    expect(text).toContain("Live");
    expect(text).not.toContain("live below");
  });

  it("shows the distinct subtree chip for a done parent with live descendants", () => {
    const text = renderLeading(
      <InboxIssueMetaLeading
        issue={makeIssue({ id: "parent", identifier: "PAP-1", status: "done" })}
        isLive={false}
        subtreeLiveCount={2}
      />,
    );
    // The done parent must NOT borrow the running child's "Live" chip.
    expect(text).toContain("2 live below");
    expect(text).not.toMatch(/(^|[^a-z])Live([^a-z]|$)/);
  });

  it("renders no live treatment when the issue and its subtree are idle", () => {
    const text = renderLeading(
      <InboxIssueMetaLeading
        issue={makeIssue({ id: "idle", identifier: "PAP-3", status: "done" })}
        isLive={false}
        subtreeLiveCount={0}
      />,
    );
    expect(text).not.toContain("Live");
    expect(text).not.toContain("live below");
  });
});

function renderTrailing(issue: Issue): { text: string; reviewCell: Element | null } {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <InboxIssueTrailingColumns
        issue={issue}
        columns={["review", "updated"]}
        projectName={null}
        projectColor={null}
        workspaceName={null}
        assigneeName={null}
        currentUserId="user-1"
        parentIdentifier={null}
        parentTitle={null}
      />,
    ),
  );
  return {
    text: container.textContent ?? "",
    reviewCell: container.querySelector("[data-testid='issue-human-review-cell']"),
  };
}

describe("InboxIssueTrailingColumns review column", () => {
  it("shows the human review label when a human is the pending reviewer", () => {
    const { text, reviewCell } = renderTrailing(
      makeIssue({
        status: "in_review",
        executionState: makeExecutionState({
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "user", userId: "user-1", agentId: null },
        }),
      }),
    );
    expect(reviewCell).not.toBeNull();
    expect(text).toContain("Review & approve/reject");
  });

  it("renders an empty review cell when an agent is the pending reviewer", () => {
    const { reviewCell } = renderTrailing(
      makeIssue({
        status: "in_review",
        executionState: makeExecutionState({
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: "agent-1", userId: null },
        }),
      }),
    );
    expect(reviewCell).toBeNull();
  });

  it("renders an empty review cell for tasks that are not in_review", () => {
    const { reviewCell } = renderTrailing(makeIssue({ status: "in_progress" }));
    expect(reviewCell).toBeNull();
  });
});
