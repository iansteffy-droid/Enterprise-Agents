// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue, IssueWorkProduct } from "@paperclipai/shared";
import {
  shouldShowExecutionDecision,
  shouldShowReviewNotice,
  decisionStatusFor,
  holdBannerText,
  ExecutionStageDecisionBanner,
} from "./ExecutionStageDecisionBanner";

// Set a controlled textarea's value the way React expects, then fire `input`.
function setTextareaValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function byTestId(id: string): HTMLElement | null {
  // Radix Dialog portals into document.body, so search the whole document.
  return document.querySelector(`[data-testid="${id}"]`);
}

function issueWith(
  executionState: unknown,
  status: Issue["status"] = "in_review",
  assigneeUserId: string | null = null,
): Pick<Issue, "status" | "executionState" | "assigneeUserId"> {
  return { status, executionState, assigneeUserId } as Pick<
    Issue,
    "status" | "executionState" | "assigneeUserId"
  >;
}

const pendingUserState = {
  status: "pending",
  currentStageType: "approval",
  currentParticipant: { type: "user", userId: "local-board", agentId: null },
  returnAssignee: { type: "agent", userId: null, agentId: "agent-1" },
};

describe("shouldShowExecutionDecision", () => {
  it("shows when in_review, pending, and the current user is the participant", () => {
    expect(shouldShowExecutionDecision(issueWith(pendingUserState), "local-board")).toBe(true);
  });

  it("hides when the issue is not in_review", () => {
    expect(shouldShowExecutionDecision(issueWith(pendingUserState, "in_progress"), "local-board")).toBe(false);
  });

  it("hides when execution state is not pending", () => {
    const changesRequested = { ...pendingUserState, status: "changes_requested" };
    expect(shouldShowExecutionDecision(issueWith(changesRequested), "local-board")).toBe(false);
  });

  it("hides when the participant is an agent", () => {
    const agentState = {
      ...pendingUserState,
      currentParticipant: { type: "agent", userId: null, agentId: "agent-1" },
    };
    expect(shouldShowExecutionDecision(issueWith(agentState), "local-board")).toBe(false);
  });

  it("hides when the participant user id does not match the current user", () => {
    expect(shouldShowExecutionDecision(issueWith(pendingUserState), "someone-else")).toBe(false);
  });

  it("hides when there is no current user", () => {
    expect(shouldShowExecutionDecision(issueWith(pendingUserState), null)).toBe(false);
  });

  it("hides when there is no execution state", () => {
    expect(shouldShowExecutionDecision(issueWith(null), "local-board")).toBe(false);
  });
});

describe("decisionStatusFor", () => {
  it("maps approve to done", () => {
    expect(decisionStatusFor("approve")).toBe("done");
  });

  it("maps request_changes to in_progress", () => {
    expect(decisionStatusFor("request_changes")).toBe("in_progress");
  });
});

describe("shouldShowReviewNotice", () => {
  it("shows when in_review and assigned to the current user with no action decision", () => {
    expect(shouldShowReviewNotice(issueWith(null, "in_review", "local-board"), "local-board")).toBe(true);
  });

  it("still shows when the action banner also applies (the two rows stack)", () => {
    // in_review, assigned to me, AND I'm the execution participant -> notice + actions stack
    expect(
      shouldShowReviewNotice(issueWith(pendingUserState, "in_review", "local-board"), "local-board"),
    ).toBe(true);
  });

  it("hides when the issue is not in_review", () => {
    expect(shouldShowReviewNotice(issueWith(null, "in_progress", "local-board"), "local-board")).toBe(false);
  });

  it("hides when the ticket is assigned to a different user", () => {
    expect(shouldShowReviewNotice(issueWith(null, "in_review", "someone-else"), "local-board")).toBe(false);
  });

  it("hides when assigned to no user", () => {
    expect(shouldShowReviewNotice(issueWith(null, "in_review", null), "local-board")).toBe(false);
  });

  it("hides when there is no current user", () => {
    expect(shouldShowReviewNotice(issueWith(null, "in_review", "local-board"), null)).toBe(false);
  });
});

describe("ExecutionStageDecisionBanner — review notice", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the notice (with name, no action buttons) when assigned to the user in review", () => {
    act(() => {
      root.render(
        <ExecutionStageDecisionBanner
          issue={issueWith(null, "in_review", "local-board")}
          currentUserId="local-board"
          onSubmitDecision={vi.fn()}
          reviewerName="Q"
          reviewerAvatarUrl="/api/assets/x/content"
        />,
      );
    });
    const notice = byTestId("review-notice");
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain("You must review this ticket for it to continue.");
    expect(byTestId("exec-approve")).toBeNull();
    expect(byTestId("exec-request-changes")).toBeNull();
    // Identity renders the name text somewhere in the banner
    expect(container.textContent).toContain("Q");
  });

  it("stacks the notice and the action banner when assigned + execution participant", () => {
    act(() => {
      root.render(
        <ExecutionStageDecisionBanner
          issue={issueWith(pendingUserState, "in_review", "local-board")}
          currentUserId="local-board"
          onSubmitDecision={vi.fn()}
          reviewerName="Q"
        />,
      );
    });
    // Both rows visible at once, in the same banner — not mutually exclusive.
    expect(byTestId("review-notice")).not.toBeNull();
    expect(byTestId("exec-approve")).not.toBeNull();
    expect(byTestId("exec-request-changes")).not.toBeNull();
  });

  // ACME-484: the server now refuses to treat a status change as a sign-off, so the
  // banner must carry the reviewer's explicit decision with the submission.
  it("submits an explicit approve decision alongside the status", async () => {
    const onSubmitDecision = vi.fn().mockResolvedValue(undefined);
    act(() => {
      root.render(
        <ExecutionStageDecisionBanner
          issue={issueWith(pendingUserState, "in_review", "local-board")}
          currentUserId="local-board"
          onSubmitDecision={onSubmitDecision}
        />,
      );
    });

    act(() => {
      (byTestId("exec-approve") as HTMLButtonElement).click();
    });
    act(() => {
      setTextareaValue(byTestId("exec-decision-comment") as HTMLTextAreaElement, "Verified");
    });
    await act(async () => {
      (byTestId("exec-decision-confirm") as HTMLButtonElement).click();
    });

    expect(onSubmitDecision).toHaveBeenCalledWith({
      status: "done",
      comment: "Verified",
      executionDecision: "approve",
    });
  });

  it("submits an explicit request_changes decision alongside the status", async () => {
    const onSubmitDecision = vi.fn().mockResolvedValue(undefined);
    act(() => {
      root.render(
        <ExecutionStageDecisionBanner
          issue={issueWith(pendingUserState, "in_review", "local-board")}
          currentUserId="local-board"
          onSubmitDecision={onSubmitDecision}
        />,
      );
    });

    act(() => {
      (byTestId("exec-request-changes") as HTMLButtonElement).click();
    });
    act(() => {
      setTextareaValue(byTestId("exec-decision-comment") as HTMLTextAreaElement, "Spinner flickers");
    });
    await act(async () => {
      (byTestId("exec-decision-confirm") as HTMLButtonElement).click();
    });

    expect(onSubmitDecision).toHaveBeenCalledWith({
      status: "in_progress",
      comment: "Spinner flickers",
      executionDecision: "request_changes",
    });
  });

  it("renders nothing when not assigned and no decision applies", () => {
    act(() => {
      root.render(
        <ExecutionStageDecisionBanner
          issue={issueWith(null, "in_review", "someone-else")}
          currentUserId="local-board"
          onSubmitDecision={vi.fn()}
        />,
      );
    });
    expect(byTestId("review-notice")).toBeNull();
    expect(byTestId("exec-approve")).toBeNull();
  });
});

function workProduct(overrides: Partial<IssueWorkProduct>): IssueWorkProduct {
  return {
    id: "wp-1",
    type: "branch",
    title: "pc/ACME-183-lean-specs",
    url: null,
    isPrimary: false,
    createdAt: new Date("2026-07-20T10:00:00Z"),
    ...overrides,
  } as IssueWorkProduct;
}

describe("ExecutionStageDecisionBanner — test branch line", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderBanner(workProducts: IssueWorkProduct[] | undefined, issue = issueWith(null, "in_review", "local-board")) {
    act(() => {
      root.render(
        <ExecutionStageDecisionBanner
          issue={issue}
          currentUserId="local-board"
          onSubmitDecision={vi.fn()}
          reviewerName="Q"
          workProducts={workProducts}
        />,
      );
    });
  }

  it("shows the test branch from a branch work product beneath the review notice", () => {
    renderBanner([workProduct({ title: "pc/ACME-183-lean-specs" })]);
    const line = byTestId("review-test-branch");
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain("Test on branch:");
    expect(line!.textContent).toContain("pc/ACME-183-lean-specs");
  });

  it("prefers the primary branch work product over others", () => {
    renderBanner([
      workProduct({ id: "wp-1", title: "pc/ACME-1-side-branch" }),
      workProduct({ id: "wp-2", title: "pc/ACME-1-main-branch", isPrimary: true }),
    ]);
    expect(byTestId("review-test-branch")!.textContent).toContain("pc/ACME-1-main-branch");
    expect(byTestId("review-test-branch")!.textContent).not.toContain("pc/ACME-1-side-branch");
  });

  it("falls back to the newest branch work product when none is primary", () => {
    renderBanner([
      workProduct({ id: "wp-1", title: "pc/ACME-1-old", createdAt: new Date("2026-07-18T10:00:00Z") }),
      workProduct({ id: "wp-2", title: "pc/ACME-1-new", createdAt: new Date("2026-07-20T10:00:00Z") }),
    ]);
    expect(byTestId("review-test-branch")!.textContent).toContain("pc/ACME-1-new");
  });

  it("copies the branch name to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderBanner([workProduct({ title: "pc/ACME-183-lean-specs" })]);
    await act(async () => {
      byTestId("review-test-branch-copy")!.click();
    });
    expect(writeText).toHaveBeenCalledWith("pc/ACME-183-lean-specs");
  });

  it("falls back to a pull_request link when no branch work product exists", () => {
    renderBanner([
      workProduct({ type: "pull_request", title: "PR #450", url: "https://github.com/example-org/app/pull/450" }),
    ]);
    const line = byTestId("review-test-branch");
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain("PR #450");
    const link = line!.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://github.com/example-org/app/pull/450");
  });

  it("renders no branch line when there are no work products", () => {
    renderBanner([]);
    expect(byTestId("review-notice")).not.toBeNull();
    expect(byTestId("review-test-branch")).toBeNull();
  });

  it("shows the branch line for the execution participant even when not the assignee", () => {
    renderBanner(
      [workProduct({ title: "pc/ACME-183-lean-specs" })],
      issueWith(pendingUserState, "in_review", "someone-else"),
    );
    expect(byTestId("exec-approve")).not.toBeNull();
    expect(byTestId("review-test-branch")).not.toBeNull();
  });
});

describe("ExecutionStageDecisionBanner", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders nothing when the decision should not show", () => {
    act(() => {
      root.render(
        <ExecutionStageDecisionBanner
          issue={issueWith(pendingUserState, "in_progress")}
          currentUserId="local-board"
          onSubmitDecision={vi.fn()}
        />,
      );
    });
    expect(byTestId("exec-approve")).toBeNull();
  });

  it("submits a Request changes decision with status in_progress and the comment", async () => {
    const onSubmitDecision = vi.fn().mockResolvedValue(undefined);
    act(() => {
      root.render(
        <ExecutionStageDecisionBanner
          issue={issueWith(pendingUserState)}
          currentUserId="local-board"
          onSubmitDecision={onSubmitDecision}
        />,
      );
    });

    act(() => byTestId("exec-request-changes")!.click());
    const comment = byTestId("exec-decision-comment") as HTMLTextAreaElement;
    act(() => setTextareaValue(comment, "Please re-verify the Schacht normalization."));
    await act(async () => {
      byTestId("exec-decision-confirm")!.click();
    });

    expect(onSubmitDecision).toHaveBeenCalledWith({
      status: "in_progress",
      comment: "Please re-verify the Schacht normalization.",
      executionDecision: "request_changes",
    });
  });

  it("submits an Approve decision with status done", async () => {
    const onSubmitDecision = vi.fn().mockResolvedValue(undefined);
    act(() => {
      root.render(
        <ExecutionStageDecisionBanner
          issue={issueWith(pendingUserState)}
          currentUserId="local-board"
          onSubmitDecision={onSubmitDecision}
        />,
      );
    });

    act(() => byTestId("exec-approve")!.click());
    act(() => setTextareaValue(byTestId("exec-decision-comment") as HTMLTextAreaElement, "Looks good."));
    await act(async () => {
      byTestId("exec-decision-confirm")!.click();
    });

    expect(onSubmitDecision).toHaveBeenCalledWith({
      status: "done",
      comment: "Looks good.",
      executionDecision: "approve",
    });
  });

  it("disables confirm until a comment is entered", () => {
    act(() => {
      root.render(
        <ExecutionStageDecisionBanner
          issue={issueWith(pendingUserState)}
          currentUserId="local-board"
          onSubmitDecision={vi.fn()}
        />,
      );
    });
    act(() => byTestId("exec-approve")!.click());
    expect((byTestId("exec-decision-confirm") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server error and keeps the dialog open when submission fails", async () => {
    const onSubmitDecision = vi.fn().mockRejectedValue(new Error("This execution stage has no return assignee"));
    act(() => {
      root.render(
        <ExecutionStageDecisionBanner
          issue={issueWith(pendingUserState)}
          currentUserId="local-board"
          onSubmitDecision={onSubmitDecision}
        />,
      );
    });
    act(() => byTestId("exec-request-changes")!.click());
    act(() => setTextareaValue(byTestId("exec-decision-comment") as HTMLTextAreaElement, "Fix it"));
    await act(async () => {
      byTestId("exec-decision-confirm")!.click();
    });
    expect(byTestId("exec-decision-error")?.textContent).toContain("no return assignee");
    expect(byTestId("exec-decision-comment")).not.toBeNull();
  });
});

const heldState = (resumeAt: string | null) => ({
  status: "held",
  currentStageType: "review",
  currentParticipant: { type: "agent", userId: null, agentId: "agent-qa" },
  returnAssignee: { type: "agent", userId: null, agentId: "agent-1" },
  hold: { reason: "Waiting on CI", resumeAt, heldBy: "participant" },
});

describe("holdBannerText", () => {
  it("names the resume time for a timed hold", () => {
    expect(holdBannerText(issueWith(heldState("2026-11-09T12:00:00.000Z")), () => "12:00")).toBe(
      "On hold — Waiting on CI (resumes 12:00)",
    );
  });

  it("says it is waiting on you for an untimed hold", () => {
    expect(holdBannerText(issueWith(heldState(null)))).toBe("On hold — Waiting on CI (waiting on you)");
  });

  it("is null when the chain is not held", () => {
    expect(holdBannerText(issueWith(pendingUserState))).toBeNull();
  });
});

describe("ExecutionStageDecisionBanner — hold", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the hold row with Resume instead of the review notice, and Resume calls onResume", async () => {
    const onResume = vi.fn().mockResolvedValue(undefined);
    act(() => {
      root.render(
        <ExecutionStageDecisionBanner
          issue={issueWith(heldState(null), "in_review", "local-board")}
          currentUserId="local-board"
          onSubmitDecision={vi.fn()}
          onResume={onResume}
        />,
      );
    });
    expect(byTestId("exec-hold")!.textContent).toContain("On hold — Waiting on CI (waiting on you)");
    expect(byTestId("review-notice")).toBeNull();
    expect(byTestId("exec-approve")).toBeNull();
    await act(async () => {
      (byTestId("exec-resume") as HTMLButtonElement).click();
    });
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("shows a resume error when the resume fails", async () => {
    const onResume = vi.fn().mockRejectedValue(new Error("nope"));
    act(() => {
      root.render(
        <ExecutionStageDecisionBanner
          issue={issueWith(heldState("2026-11-09T12:00:00.000Z"))}
          currentUserId="local-board"
          onSubmitDecision={vi.fn()}
          onResume={onResume}
        />,
      );
    });
    expect(byTestId("exec-hold")!.textContent).toContain("resumes");
    await act(async () => {
      (byTestId("exec-resume") as HTMLButtonElement).click();
    });
    expect(byTestId("exec-resume-error")!.textContent).toContain("nope");
  });

  it("hides Resume when there is no signed-in user", () => {
    act(() => {
      root.render(
        <ExecutionStageDecisionBanner
          issue={issueWith(heldState(null))}
          currentUserId={null}
          onSubmitDecision={vi.fn()}
          onResume={vi.fn()}
        />,
      );
    });
    expect(byTestId("exec-hold")).not.toBeNull();
    expect(byTestId("exec-resume")).toBeNull();
  });
});
