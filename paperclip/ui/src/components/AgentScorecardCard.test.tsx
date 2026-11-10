// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentScorecard } from "@paperclipai/shared";
import { AgentScorecardCard } from "./AgentScorecardCard";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function act(cb: () => void | Promise<void>) {
  let result: void | Promise<void>;
  flushSync(() => {
    result = cb();
  });
  await result!;
}

const data: AgentScorecard = {
  agentId: "a1",
  agentName: "Engineer",
  window: "all_time",
  issueStatusCounts: [
    { status: "done", count: 4 },
    { status: "blocked", count: 1 },
  ],
  completedIssues: 4,
  blockedIssues: 1,
  openIssues: 2,
  downvotes: 3,
  upvotes: 5,
  costCents: 250,
  inputTokens: 1000,
  cachedInputTokens: 0,
  outputTokens: 500,
  runtimeMs: 120000,
  runCount: 7,
  costCentsPerCompletedIssue: 62.5,
  tokensPerCompletedIssue: 375,
};

describe("AgentScorecardCard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container.remove();
  });

  it("renders the key metrics", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(<AgentScorecardCard data={data} />);
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Completed");
    expect(text).toContain("4");
    expect(text).toContain("Downvotes");
    expect(text).toContain("3");
    expect(text).toContain("$2.50");
  });
});
