import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentErrorBadge, agentErrorLabel } from "./AgentErrorBadge";

describe("agentErrorLabel", () => {
  it("uses the singular noun for one agent", () => {
    expect(agentErrorLabel(1)).toBe("1 agent in an error state, needs attention");
  });

  it("uses the plural noun for more than one agent", () => {
    expect(agentErrorLabel(3)).toBe("3 agents in an error state, needs attention");
  });
});

describe("AgentErrorBadge", () => {
  it("renders nothing when the count is zero", () => {
    expect(renderToStaticMarkup(<AgentErrorBadge count={0} />)).toBe("");
  });

  it("renders nothing when the count is negative", () => {
    expect(renderToStaticMarkup(<AgentErrorBadge count={-1} />)).toBe("");
  });

  it("shows the count and the accessible label when expanded", () => {
    const html = renderToStaticMarkup(<AgentErrorBadge count={3} />);
    expect(html).toContain('data-testid="sidebar-error-badge"');
    expect(html).toContain(">3<");
    expect(html).toContain("3 agents in an error state, needs attention");
    expect(html).toContain("motion-safe:animate-pulse");
  });

  it("renders a dot without the number in the rail", () => {
    const html = renderToStaticMarkup(<AgentErrorBadge count={3} rail />);
    expect(html).toContain('data-testid="sidebar-error-badge"');
    expect(html).not.toContain(">3<");
    expect(html).toContain("shadow-[0_0_0_2px_hsl(var(--background))]");
  });
});
