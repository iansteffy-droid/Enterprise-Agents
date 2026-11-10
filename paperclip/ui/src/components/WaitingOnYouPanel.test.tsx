// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Issue, PendingHumanInputItem } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    className,
    disableIssueQuicklook: _disableIssueQuicklook,
    issuePrefetch: _issuePrefetch,
    ...props
  }: React.ComponentProps<"a"> & { disableIssueQuicklook?: boolean; issuePrefetch?: Issue | null }) => (
    <a className={className} {...props}>
      {children}
    </a>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { WaitingOnYouPanel } from "./WaitingOnYouPanel";

function makeItem(overrides: Partial<PendingHumanInputItem> = {}): PendingHumanInputItem {
  return {
    id: "approval-1",
    source: "approval",
    kind: "approval",
    issue: { id: "issue-1", identifier: "PAP-1", title: "Ship the thing" },
    message: "Please approve this action.",
    acceptLabel: "Approve",
    rejectLabel: "Reject",
    canResolveInline: true,
    requestingAgent: { id: "agent-1", name: "Riker", avatarUrl: null },
    createdAt: "2026-08-17T10:00:00.000Z",
    ...overrides,
  };
}

describe("WaitingOnYouPanel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:00:00.000Z"));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("shows when each request was made as a relative timestamp", () => {
    act(() => {
      root.render(<WaitingOnYouPanel items={[makeItem()]} />);
    });

    const headers = [...container.querySelectorAll("th")].map((th) => th.textContent);
    expect(headers).toContain("Requested");
    expect(container.textContent).toContain("2h ago");
  });

  it("carries the absolute timestamp in the cell tooltip", () => {
    act(() => {
      root.render(<WaitingOnYouPanel items={[makeItem()]} />);
    });

    const cell = [...container.querySelectorAll("td")].find((td) =>
      td.textContent?.includes("2h ago"),
    );
    expect(cell).toBeDefined();
    const titled = cell!.querySelector("[title]") ?? cell!;
    expect(titled.getAttribute("title")).toBe(new Date("2026-08-17T10:00:00.000Z").toLocaleString());
  });

  it("falls back to a dash when the timestamp is missing", () => {
    act(() => {
      // Review rows synthesize createdAt from issue.updatedAt and produce ""
      // when the date fails to parse.
      root.render(<WaitingOnYouPanel items={[makeItem({ createdAt: "" })]} />);
    });

    const requestedIndex = [...container.querySelectorAll("th")].findIndex(
      (th) => th.textContent === "Requested",
    );
    expect(requestedIndex).toBeGreaterThan(-1);
    const row = container.querySelector("tbody tr");
    expect(row?.querySelectorAll("td")[requestedIndex]?.textContent).toBe("—");
  });
});
