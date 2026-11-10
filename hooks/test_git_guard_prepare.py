#!/usr/bin/env python3
"""Tests for the prepare-for-merge relaxations (rebase + worktree) in git-guard.py.

Run: python3 test_git_guard_prepare.py   (no pytest required)
Exit 0 = all pass, 1 = a failure.
"""
import json
import os
import subprocess
import sys
import tempfile

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "git-guard.py")
AGENT = "agent-a"
FORCE = {"GIT_GUARD_FORCE_PUSH_ALLOW": "1"}


def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True,
                   capture_output=True, text=True)


def make_repo(branch):
    """A throwaway repo with a `master` and a `pc/test-1` branch, checked out to `branch`."""
    d = tempfile.mkdtemp(prefix="gg-prep-")
    _git(d, "init", "-q")
    _git(d, "config", "user.email", "t@t")
    _git(d, "config", "user.name", "t")
    _git(d, "commit", "-q", "--allow-empty", "-m", "root")
    _git(d, "branch", "-M", "master")
    _git(d, "checkout", "-q", "-b", "pc/test-1")
    _git(d, "checkout", "-q", branch)
    return d


def run(cmd, agent_id, cwd, extra=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_GUARD_")}
    env.update(extra or {})
    if agent_id is None:
        env.pop("PAPERCLIP_AGENT_ID", None)
    else:
        env["PAPERCLIP_AGENT_ID"] = agent_id
    payload = json.dumps({"tool_input": {"command": cmd}, "cwd": cwd})
    return subprocess.run(
        [sys.executable, HOOK], input=payload, env=env,
        capture_output=True, text=True,
    ).returncode


def main():
    feat = make_repo("pc/test-1")
    main_tree = make_repo("master")

    cases = [
        # (name, cmd, agent, cwd, extra_env, expected_exit)
        ("rebase onto origin/master allowed with the prepare env on a feature branch",
         "git rebase origin/master", AGENT, feat, FORCE, 0),
        ("rebase onto bare local master blocked (spec envelope)",
         "git rebase master", AGENT, feat, FORCE, 2),
        ("rebase blocked without the prepare env",
         "git rebase origin/master", AGENT, feat, None, 2),
        ("rebase blocked while on mainline even with the env",
         "git rebase origin/master", AGENT, main_tree, FORCE, 2),
        ("interactive rebase blocked",
         "git rebase -i origin/master", AGENT, feat, FORCE, 2),
        ("rebase --abort allowed with the env",
         "git rebase --abort", AGENT, feat, FORCE, 0),
        ("reset --soft (squash) allowed on a feature branch",
         "git reset --soft HEAD~1", AGENT, feat, None, 0),
        ("push feature branch (force-with-lease) allowed with the env",
         "git push --force-with-lease origin pc/test-1", AGENT, feat, FORCE, 0),
        ("force-with-lease push blocked without the env",
         "git push --force-with-lease origin pc/test-1", AGENT, feat, None, 2),
        ("push to master blocked even with the env",
         "git push origin master", AGENT, feat, FORCE, 2),
        ("push HEAD:master blocked even with the env",
         "git push origin HEAD:master", AGENT, feat, FORCE, 2),
        ("delete master blocked",
         "git push origin :master", AGENT, feat, FORCE, 2),
        ("push --all blocked",
         "git push --all origin", AGENT, feat, FORCE, 2),
        ("bare push while on mainline blocked",
         "git push", AGENT, main_tree, None, 2),
        ("worktree add on a feature branch allowed with the env",
         "git worktree add /tmp/gg-wt pc/test-1", AGENT, feat, FORCE, 0),
        ("worktree add on master blocked with the env",
         "git worktree add /tmp/gg-wt master", AGENT, feat, FORCE, 2),
        ("worktree blocked without the env",
         "git worktree add /tmp/gg-wt pc/test-1", AGENT, feat, None, 2),
        ("worktree remove allowed with the env",
         "git worktree remove /tmp/gg-wt", AGENT, feat, FORCE, 0),
        ("worktree prune allowed with the env",
         "git worktree prune", AGENT, feat, FORCE, 0),
    ]

    failures = 0
    for name, cmd, agent, cwd, extra, expected in cases:
        got = run(cmd, agent, cwd, extra)
        ok = got == expected
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: exit={got} (expected {expected})")
        if not ok:
            failures += 1
    print(f"\n{len(cases) - failures}/{len(cases)} passed")
    return 1 if failures else 0


def test_all():
    assert main() == 0


if __name__ == "__main__":
    sys.exit(main())
