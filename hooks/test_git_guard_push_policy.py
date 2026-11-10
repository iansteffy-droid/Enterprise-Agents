#!/usr/bin/env python3
"""Tests for the git-guard push policy and its env contract.

Run: python3 test_git_guard_push_policy.py   (or python3 -m pytest hooks/ -q)
Exit 0 = all pass, 1 = a failure.
"""
import json
import os
import subprocess
import sys
import tempfile

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "git-guard.py")


def feature_repo():
    d = tempfile.mkdtemp(prefix="gg-push-")
    for args in (["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                 ["commit", "-q", "--allow-empty", "-m", "root"], ["checkout", "-q", "-b", "feat/x"]):
        subprocess.run(["git", *args], cwd=d, check=True, capture_output=True)
    return d


CWD = feature_repo()


def run(cmd, agent_id="any-agent-id", extra=None):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("GIT_GUARD_") and k != "PRODUCT_OPERATOR_TREE"}
    if agent_id is None:
        env.pop("PAPERCLIP_AGENT_ID", None)
    else:
        env["PAPERCLIP_AGENT_ID"] = agent_id
    env.update(extra or {})
    payload = json.dumps({"tool_input": {"command": cmd}, "cwd": CWD})
    return subprocess.run([sys.executable, HOOK], input=payload, env=env,
                          capture_output=True, text=True).returncode


FORCE = {"GIT_GUARD_FORCE_PUSH_ALLOW": "1"}
GLOB = {"GIT_GUARD_PUSH_ALLOW": "retro/*"}
DEVELOP = {"GIT_GUARD_MAINLINE": "develop"}

CASES = [
    ("any agent id may push a non-mainline branch", "git push origin feat/x", None, 0),
    ("a different agent id may too", "git push origin feat/x", {}, 0),
    ("push HEAD:master blocked", "git push origin HEAD:master", None, 2),
    ("push feat/x:main blocked", "git push origin feat/x:main", None, 2),
    ("push refs/heads/master blocked", "git push origin HEAD:refs/heads/master", None, 2),
    ("push master blocked", "git push origin master", None, 2),
    ("delete master blocked", "git push origin :master", None, 2),
    ("push --all blocked", "git push --all origin", None, 2),
    ("push --mirror blocked", "git push --mirror origin", None, 2),
    ("--force blocked", "git push --force origin feat/x", None, 2),
    ("--force blocked even with the force env", "git push --force origin feat/x", FORCE, 2),
    ("--force-with-lease blocked by default", "git push --force-with-lease origin feat/x", None, 2),
    ("--force-with-lease allowed with the force env", "git push --force-with-lease origin feat/x", FORCE, 0),
    ("--force-with-lease to mainline blocked even with the env",
     "git push --force-with-lease origin master", FORCE, 2),
    ("push allow glob: matching branch allowed", "git push origin retro/ISSUE-1", GLOB, 0),
    ("push allow glob: other branch blocked", "git push origin feat/x", GLOB, 2),
    ("fetch allowed for any agent", "git fetch origin", None, 0),
    ("custom mainline: develop blocked", "git push origin develop", DEVELOP, 2),
    ("custom mainline: master now allowed", "git push origin master", DEVELOP, 0),
    ("human session untouched", "git push origin master", "human", 0),
]


def main():
    failures = 0
    for name, cmd, extra, expected in CASES:
        if extra == "human":
            got = run(cmd, agent_id=None)
        else:
            got = run(cmd, extra=extra)
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
