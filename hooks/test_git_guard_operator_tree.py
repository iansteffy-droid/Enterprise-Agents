#!/usr/bin/env python3
"""Tests for two git-guard rules added (operator-tree and tree-resolution rules):

1. Agents never move HEAD (`git switch` / `git checkout`) inside the OPERATOR's own
   checkout — not to master, not to any other branch, not to "free a lock". The
   operator checks branches out there to test; the fleet works in its own worktree.
2. git-guard resolves the tree a git call really runs in (`cd <dir> && git …`,
   `git -C <dir> …`) instead of always reading the branch of the payload cwd — so
   the mainline checks (commit/merge on master) cannot be bypassed with a `cd`.

The operator tree is injected via PRODUCT_OPERATOR_TREE so the test never touches
the real one.

Run: python3 test_git_guard_operator_tree.py   (no pytest required)
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


def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True,
                   capture_output=True, text=True)


def make_repo(branch):
    """A throwaway repo with `master`, `pc/test-1`, `pc/test-2`, checked out to `branch`."""
    d = tempfile.mkdtemp(prefix="gg-optree-")
    _git(d, "init", "-q")
    _git(d, "config", "user.email", "t@t")
    _git(d, "config", "user.name", "t")
    _git(d, "commit", "-q", "--allow-empty", "-m", "root")
    _git(d, "branch", "-M", "master")
    _git(d, "branch", "pc/test-1")
    _git(d, "branch", "pc/test-2")
    _git(d, "checkout", "-q", branch)
    return os.path.realpath(d)


def run(cmd, agent_id, cwd, operator_tree):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_GUARD_")}
    if agent_id is None:
        env.pop("PAPERCLIP_AGENT_ID", None)
    else:
        env["PAPERCLIP_AGENT_ID"] = agent_id
    env["PRODUCT_OPERATOR_TREE"] = operator_tree
    payload = json.dumps({"tool_input": {"command": cmd}, "cwd": cwd})
    return subprocess.run(
        [sys.executable, HOOK], input=payload, env=env,
        capture_output=True, text=True,
    ).returncode


def main():
    op = make_repo("pc/test-1")        # the operator's checkout, parked on a feature branch
    fleet = make_repo("pc/test-1")     # the agent's own worktree
    on_master = make_repo("master")    # a plain tree sitting on master (cd-resolution cases)

    cases = [
        # --- rule 1: no HEAD move in the operator's tree -------------------------------
        ("checkout in operator tree via cd blocked for agent A (the park-the-tree move)",
         f"cd {op} && git checkout test-task-1", AGENT_A, fleet, 2),
        ("switch in operator tree via git -C blocked for agent B",
         f"git -C {op} switch pc/test-2", AGENT_B, fleet, 2),
        ("checkout -b in operator tree blocked",
         f"cd {op} && git checkout -b pc/new", AGENT_A, fleet, 2),
        ("switch - (previous branch) in operator tree blocked",
         f"cd {op} && git switch -", AGENT_A, fleet, 2),
        ("switch blocked when the operator tree IS the payload cwd",
         "git switch pc/test-2", AGENT_A, op, 2),
        ("relative cd into the operator tree blocked",
         f"cd {os.path.basename(op)} && git switch pc/test-2", AGENT_A, os.path.dirname(op), 2),
        ("two cds: the last one wins",
         f"cd {fleet} && cd {op} && git switch pc/test-2", AGENT_A, fleet, 2),
        ("merge in operator tree still allowed (no HEAD move; feature branch)",
         f"cd {op} && git merge pc/test-2", AGENT_A, fleet, 0),
        ("read-only status in operator tree allowed",
         f"cd {op} && git status", AGENT_A, fleet, 0),
        ("branch -d in operator tree allowed (no HEAD move)",
         f"cd {op} && git branch -d pc/test-2", AGENT_A, fleet, 0),
        ("switch in the fleet worktree allowed",
         "git switch pc/test-2", AGENT_B, fleet, 0),
        ("switch in fleet via cd allowed even though payload cwd is the operator tree",
         f"cd {fleet} && git switch pc/test-2", AGENT_B, op, 0),
        ("human session (no agent id) passes through",
         f"cd {op} && git switch pc/test-2", None, fleet, 0),
        # --- rule 2: mainline checks use the tree the call runs in ----------------------
        ("commit on master via cd blocked although payload cwd is a feature branch",
         f"cd {on_master} && git commit -m x", AGENT_B, fleet, 2),
        ("commit on master via git -C blocked",
         f"git -C {on_master} commit -m x", AGENT_A, fleet, 2),
        ("merge on master via cd blocked",
         f"cd {on_master} && git merge pc/test-1", AGENT_A, fleet, 2),
        ("commit on a feature branch via cd allowed although payload cwd is on master",
         f"cd {fleet} && git commit -m x", AGENT_B, on_master, 0),
    ]

    # --- rule 3: the kit checkout is an operator tree too (colon list) -----------------
    # new-client writes PRODUCT_OPERATOR_TREE=<client operator tree>:<kit root>; the kit's
    # own fleet worktree (a linked worktree elsewhere) stays free for retro branches.
    kit = make_repo("master")
    kit_fleet = os.path.realpath(tempfile.mkdtemp(prefix="gg-kitfleet-")) + "/wt"
    _git(kit, "worktree", "add", "-q", "--detach", kit_fleet, "master")
    both = f"{op}:{kit}"
    kit_cases = [
        ("switch -c in the kit checkout blocked",
         f"git -C {kit} switch -c x", AGENT_A, fleet, 2),
        ("checkout in the kit checkout via cd blocked",
         f"cd {kit} && git checkout pc/test-1", AGENT_A, fleet, 2),
        ("worktree list in the kit checkout allowed",
         f"git -C {kit} worktree list", AGENT_A, fleet, 0),
        ("switch -c retro/x in the kit fleet worktree allowed",
         f"git -C {kit_fleet} switch -c retro/x", AGENT_A, fleet, 0),
        ("the client operator tree is still guarded with the list",
         f"git -C {op} switch pc/test-2", AGENT_B, fleet, 2),
    ]

    failures = 0
    for name, cmd, agent, cwd, expected, optree in (
        [(*c, op) for c in cases] + [(*c, both) for c in kit_cases]
    ):
        got = run(cmd, agent, cwd, optree)
        ok = got == expected
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: exit={got} (expected {expected})")
        if not ok:
            failures += 1
    cases = cases + kit_cases
    print(f"\n{len(cases) - failures}/{len(cases)} passed")
    return 1 if failures else 0


def test_all():
    assert main() == 0


if __name__ == "__main__":
    sys.exit(main())
