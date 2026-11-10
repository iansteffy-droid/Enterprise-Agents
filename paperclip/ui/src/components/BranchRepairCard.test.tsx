// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BranchRepairCard } from "./BranchRepairCard";

const inReview = { id: "iss-1", status: "in_review" } as unknown as Parameters<
  typeof BranchRepairCard
>[0]["issue"];

describe("BranchRepairCard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });
  afterEach(() => {
    root?.unmount();
    container.remove();
  });

  function render(props: Parameters<typeof BranchRepairCard>[0]) {
    root = createRoot(container);
    flushSync(() => root!.render(<BranchRepairCard {...props} />));
  }

  it("shows the Prepare for merge button when the ticket is in_review", () => {
    render({ issue: inReview, onRepair: vi.fn(), isPending: false });
    expect(container.textContent).toContain("Prepare for merge");
    expect(container.textContent).toContain("rebases it onto its base");
    expect(container.textContent).toContain("force-with-lease");
    expect(container.textContent).not.toMatch(/master/i);
  });

  it("hides when the ticket is not in_review", () => {
    render({
      issue: { ...inReview, status: "in_progress" } as typeof inReview,
      onRepair: vi.fn(),
      isPending: false,
    });
    expect(container.querySelector("button")).toBeNull();
  });

  it("disables the button while pending", () => {
    render({ issue: inReview, onRepair: vi.fn(), isPending: true });
    expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  });

  it("calls onRepair on click", () => {
    const onRepair = vi.fn();
    render({ issue: inReview, onRepair, isPending: false });
    flushSync(() => {
      container.querySelector<HTMLButtonElement>("button")?.click();
    });
    expect(onRepair).toHaveBeenCalledOnce();
  });
});
