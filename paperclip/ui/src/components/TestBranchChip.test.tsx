// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TestBranchChip } from "./TestBranchChip";

/**
 * The header chip shows the branch a ticket's crew worked on so an operator can
 * check it out and test. It must render the exact branch name (mono, copyable)
 * and disappear entirely when there is no known branch.
 */
describe("TestBranchChip", () => {
  it("renders the branch name in a copyable button", () => {
    const html = renderToStaticMarkup(<TestBranchChip branchName="pc/ACME-258-handoff" />);
    expect(html).toContain("pc/ACME-258-handoff");
    expect(html).toContain("font-mono");
    expect(html).toContain("<button");
    expect(html).toContain('data-testid="issue-detail-test-branch"');
    expect(html).toContain("click to copy");
  });

  it("renders nothing when the branch is unknown", () => {
    expect(renderToStaticMarkup(<TestBranchChip branchName={null} />)).toBe("");
    expect(renderToStaticMarkup(<TestBranchChip branchName={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<TestBranchChip branchName="" />)).toBe("");
  });

  it("labels a branch inherited from an ancestor via the parent-branch rule", () => {
    const html = renderToStaticMarkup(
      <TestBranchChip branchName="pc/ACME-290-arbeitsplatz-stale-refix" via="ACME-290" />,
    );
    expect(html).toContain("pc/ACME-290-arbeitsplatz-stale-refix");
    expect(html).toContain("parent branch");
  });

  it("shows no parent hint for the ticket's own branch", () => {
    const html = renderToStaticMarkup(<TestBranchChip branchName="pc/ACME-258-handoff" via={null} />);
    expect(html).not.toContain("parent branch");
  });
});
