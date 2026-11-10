#!/usr/bin/env python3
"""Standalone tests for the read-only `git fetch` (allowed for every agent) in git-guard.py.

Run: python3 test_git_guard_fetch.py   (no pytest required)
Exit 0 = all pass, 1 = a failure.
"""
import json
import os
import subprocess
import sys
import tempfile

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "git-guard.py")
AGENT_A = "agent-a"
AGENT_B = "agent-b"


def feature_repo():
    """A throwaway repo on a feature branch: the hook reads the branch of the payload
    cwd, so running from a directory that sits on master wrongly blocked `git commit`."""
    d = tempfile.mkdtemp(prefix="gg-fetch-")
    for args in (["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                 ["commit", "-q", "--allow-empty", "-m", "root"], ["checkout", "-q", "-b", "pc/test-1"]):
        subprocess.run(["git", *args], cwd=d, check=True, capture_output=True)
    return d


CWD = feature_repo()


def run(cmd, agent_id):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_GUARD_")}
    if agent_id is None:
        env.pop("PAPERCLIP_AGENT_ID", None)
    else:
        env["PAPERCLIP_AGENT_ID"] = agent_id
    payload = json.dumps({"tool_input": {"command": cmd}, "cwd": CWD})
    return subprocess.run(
        [sys.executable, HOOK], input=payload, env=env,
        capture_output=True, text=True,
    ).returncode


CASES = [
    ("fetch allowed for agent A", "git fetch origin master", AGENT_A, 0),
    ("fetch allowed for agent B", "git fetch origin master", AGENT_B, 0),
    ("fetch allowed for a human session", "git fetch origin master", None, 0),
    ("push to master blocked", "git push origin master", AGENT_A, 2),
    ("pull still blocked", "git pull", AGENT_A, 2),
    ("rebase blocked without the prepare-for-merge env", "git rebase origin/master", AGENT_B, 2),
    ("commit still allowed on a feature branch", "git commit -m x", AGENT_A, 0),
    ("merge-tree (read-only detect) allowed", "git merge-tree --write-tree origin/master HEAD", AGENT_A, 0),
    ("merge-tree allowed for other agent too (read-only)", "git merge-tree --write-tree origin/master HEAD", AGENT_B, 0),
]


def main():
    failures = 0
    for name, cmd, agent, expected in CASES:
        got = run(cmd, agent)
        ok = got == expected
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: exit={got} (expected {expected})")
        if not ok:
            failures += 1
    print(f"\n{len(CASES) - failures}/{len(CASES)} passed")
    return 1 if failures else 0


def test_all():
    assert main() == 0


if __name__ == "__main__":
    sys.exit(main())
