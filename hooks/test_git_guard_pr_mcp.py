#!/usr/bin/env python3
"""git-guard: the GitHub MCP path. Agents never write a PR (operator rule 2026-11-11).

Run: python3 hooks/test_git_guard_pr_mcp.py   Exit 0 = all pass, 1 = a failure.
"""
import json
import os
import subprocess
import sys

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "git-guard.py")


def run(tool, agent="agent-under-test"):
    env = {k: v for k, v in os.environ.items() if k != "PAPERCLIP_AGENT_ID"}
    if agent:
        env["PAPERCLIP_AGENT_ID"] = agent
    p = subprocess.run([sys.executable, HOOK], input=json.dumps({"tool_name": tool, "tool_input": {}}),
                       capture_output=True, text=True, env=env)
    return p.returncode


CASES = [
    ("create_pull_request blocked", "mcp__plugin_github_github__create_pull_request", 2),
    ("update_pull_request blocked", "mcp__plugin_github_github__update_pull_request", 2),
    ("merge_pull_request blocked", "mcp__github__merge_pull_request", 2),
    ("update_pull_request_branch blocked", "mcp__github__update_pull_request_branch", 2),
    ("request_copilot_review blocked", "mcp__github__request_copilot_review", 2),
    ("list_pull_requests allowed", "mcp__plugin_github_github__list_pull_requests", 0),
    ("pull_request_read allowed", "mcp__plugin_github_github__pull_request_read", 0),
    ("add_issue_comment allowed", "mcp__plugin_github_github__add_issue_comment", 0),
]


def main():
    fails = 0
    for name, tool, want in CASES:
        rc = run(tool)
        ok = rc == want
        print(("[PASS] " if ok else "[FAIL] ") + name + ("" if ok else ": rc=%d want=%d" % (rc, want)))
        fails += not ok
    ok = run("mcp__github__create_pull_request", agent=None) == 0
    print(("[PASS] " if ok else "[FAIL] ") + "human session passes")
    fails += not ok
    print("%d/%d passed" % (len(CASES) + 1 - fails, len(CASES) + 1))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
