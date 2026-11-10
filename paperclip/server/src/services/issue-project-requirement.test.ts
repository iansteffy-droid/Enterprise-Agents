import { describe, expect, it } from "vitest";
import { assertIssueProjectSelected } from "./issue-project-requirement.js";

/**
 * ACME-484 ran its whole life — triage, dispatch, implementation, three review
 * gates, closure — with no project, because nothing on the create path ever
 * asked for one. A top-level ticket must name the project it belongs to;
 * children inherit theirs from the parent (services/issues.ts), so they don't.
 */
describe("assertIssueProjectSelected", () => {
  it("rejects a top-level issue created without a project", () => {
    expect(() =>
      assertIssueProjectSelected({ projectId: null, parentId: null, companyHasProjects: true }),
    ).toThrow("projectId is required");
  });

  it("rejects a top-level issue when projectId is simply absent", () => {
    expect(() =>
      assertIssueProjectSelected({ companyHasProjects: true }),
    ).toThrow("projectId is required");
  });

  it("accepts a top-level issue that names its project", () => {
    expect(() =>
      assertIssueProjectSelected({
        projectId: "7ae8ccec-80c3-4857-ab32-575a21270ae6",
        parentId: null,
        companyHasProjects: true,
      }),
    ).not.toThrow();
  });

  it("accepts a subtask without a project — it inherits the parent's", () => {
    expect(() =>
      assertIssueProjectSelected({ projectId: null, parentId: "par-1", companyHasProjects: true }),
    ).not.toThrow();
  });

  it("accepts anything in a company that has no projects yet", () => {
    expect(() =>
      assertIssueProjectSelected({ projectId: null, parentId: null, companyHasProjects: false }),
    ).not.toThrow();
  });
});
