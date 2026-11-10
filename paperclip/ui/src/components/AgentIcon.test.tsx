// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentIcon } from "./AgentIconPicker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(node));
  return container;
}
afterEach(() => {
  container?.remove();
  container = null;
});

describe("AgentIcon", () => {
  it("renders an img when avatarUrl is set", () => {
    const el = render(<AgentIcon icon="bot" avatarUrl="/api/assets/a1/content" />);
    const img = el.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("/api/assets/a1/content");
    expect(el.querySelector("svg")).toBeNull();
  });

  it("renders the lucide icon when avatarUrl is absent", () => {
    const el = render(<AgentIcon icon="bot" avatarUrl={null} />);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("svg")).not.toBeNull();
  });
});
