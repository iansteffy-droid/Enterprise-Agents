import { unprocessable } from "../errors.js";

/**
 * Every ticket must belong to a project.
 *
 * ACME-484 was created from the board UI with no project and stayed project-less
 * through triage, dispatch, implementation and three review gates — nothing on
 * the way asked for one, so the work never showed up under the product it was
 * built for. Ask once, at creation, where it is cheap to answer.
 *
 * Two deliberate exemptions:
 *  - Subtasks: `issueService.create` copies the parent's project onto the child,
 *    so requiring it again would force callers to repeat what the tree knows.
 *  - Companies with no projects yet (fresh onboarding): there is nothing to pick.
 */
export function assertIssueProjectSelected(input: {
  projectId?: string | null;
  parentId?: string | null;
  companyHasProjects: boolean;
}): void {
  if (!input.companyHasProjects) return;
  if (input.parentId) return;
  if (input.projectId) return;
  throw unprocessable("projectId is required: pick the project this ticket belongs to");
}
