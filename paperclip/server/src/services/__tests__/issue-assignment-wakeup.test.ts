import { describe, expect, it, vi } from "vitest";

import { queueIssueAssignmentWakeup } from "../issue-assignment-wakeup.js";

function makeDeps() {
  const wakeup = vi.fn().mockResolvedValue({ id: "run_1" });
  return { heartbeat: { wakeup }, wakeup };
}

function callFor(status: string, assigneeAgentId: string | null = "agent_1") {
  const { heartbeat, wakeup } = makeDeps();
  const result = queueIssueAssignmentWakeup({
    heartbeat,
    issue: { id: "issue_1", assigneeAgentId, status },
    reason: "issue_assigned",
    mutation: "assignment_change",
    contextSource: "test",
  });
  return { result, wakeup };
}

describe("queueIssueAssignmentWakeup", () => {
  it("wakes the assignee for live, activated statuses", () => {
    for (const status of ["todo", "in_progress", "in_review", "blocked"]) {
      const { wakeup } = callFor(status);
      expect(wakeup, `expected wakeup for status "${status}"`).toHaveBeenCalledTimes(1);
      expect(wakeup).toHaveBeenCalledWith("agent_1", expect.objectContaining({ source: "assignment" }));
    }
  });

  it("returns early (no wakeup) for terminal, paused, and backlog statuses", () => {
    for (const status of ["done", "cancelled", "paused", "backlog"]) {
      const { result, wakeup } = callFor(status);
      expect(result, `expected no promise for status "${status}"`).toBeUndefined();
      expect(wakeup, `expected no wakeup for status "${status}"`).not.toHaveBeenCalled();
    }
  });

  it("returns early when there is no assignee", () => {
    const { result, wakeup } = callFor("in_progress", null);
    expect(result).toBeUndefined();
    expect(wakeup).not.toHaveBeenCalled();
  });
});
