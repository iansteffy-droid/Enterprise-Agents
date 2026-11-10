#!/usr/bin/env python3
"""Regression tests for the reviewer's bypass probes against git-guard.py: glued shell
separators, push option parsing, HEAD/@ resolution, refspec normalisation, combined
flags, config overrides, malformed mainline config, operator-tree worktree removal.

Run: python3 test_git_guard_bypass.py   (or pytest)
Exit 0 = all pass, 1 = a failure.
"""
import json
import os
import subprocess
import sys
import tempfile

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "git-guard.py")


def make_repo(branch):
    d = tempfile.mkdtemp(prefix="gg-byp-")
    for args in (["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                 ["commit", "-q", "--allow-empty", "-m", "root"], ["branch", "-M", "master"],
                 ["checkout", "-q", "-B", branch]):
        subprocess.run(["git", *args], cwd=d, check=True, capture_output=True)
    return os.path.realpath(d)


FEAT = make_repo("feat/x")
MAIN = make_repo("master")
OPTREE = make_repo("feat/op")
FORCE = {"GIT_GUARD_FORCE_PUSH_ALLOW": "1"}


def run(cmd, cwd=FEAT, extra=None):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("GIT_GUARD_") and k != "PRODUCT_OPERATOR_TREE"}
    env["PAPERCLIP_AGENT_ID"] = "agent-a"
    env["PRODUCT_OPERATOR_TREE"] = OPTREE
    env.update(extra or {})
    payload = json.dumps({"tool_input": {"command": cmd}, "cwd": cwd})
    return subprocess.run([sys.executable, HOOK], input=payload, env=env,
                          capture_output=True, text=True).returncode


B, A = 2, 0  # blocked, allowed
CASES = [
    # --- C1: separators glued to words -------------------------------------------------
    ("glued ; after master", "git push origin master;", FEAT, None, B),
    ("glued > after master", "git push origin master>/dev/null", FEAT, None, B),
    ("glued ) after master", "(git push origin master)", FEAT, None, B),
    ("glued | after refspec", "git push origin HEAD:master|cat", FEAT, None, B),
    ("echo;git push", "echo hi;git push origin master", FEAT, None, B),
    ("commit;git reset --hard", "git commit -m x;git reset --hard", FEAT, None, B),
    ("newline separator", "echo hi\ngit push origin master", FEAT, None, B),
    ("backtick separator", "echo `git push origin master`", FEAT, None, B),
    ("$( ) substitution", "echo $(git push origin master)", FEAT, None, B),
    ("unbalanced quote fails closed", "git commit -m 'x", FEAT, None, B),
    ("separator inside a quoted message is not a command", "git commit -m 'a; git reset --hard'", FEAT, None, A),
    ("glued ; after a feature push stays allowed", "git push origin feat/x;", FEAT, None, A),
    # --- C2: destination resolution / option parsing -----------------------------------
    ("--repo=origin HEAD:master", "git push --repo=origin HEAD:master", FEAT, None, B),
    ("--repo origin HEAD:master", "git push --repo origin HEAD:master", FEAT, None, B),
    ("push origin HEAD on master", "git push origin HEAD", MAIN, None, B),
    ("push -u origin HEAD on master", "git push -u origin HEAD", MAIN, None, B),
    ("push origin @ on master", "git push origin @", MAIN, None, B),
    ("push origin HEAD on a feature branch", "git push origin HEAD", FEAT, None, A),
    ("-o value is not a refspec", "git push -o ci.skip origin feat/x", FEAT, None, A),
    ("-o value then mainline", "git push -o ci.skip origin master", FEAT, None, B),
    ("--push-option=x allowed", "git push --push-option=x origin feat/x", FEAT, None, A),
    ("--push-option x allowed", "git push --push-option x origin feat/x", FEAT, None, A),
    ("--receive-pack blocked", "git push --receive-pack=/bin/true origin feat/x", FEAT, None, B),
    ("--exec blocked", "git push --exec /bin/true origin feat/x", FEAT, None, B),
    ("unknown option fails closed", "git push --frobnicate origin feat/x", FEAT, None, B),
    ("unknown short option fails closed", "git push -z origin feat/x", FEAT, None, B),
    # --- I1: clustered short flags -----------------------------------------------------
    ("-fu cluster is a force", "git push -fu origin feat/x", FEAT, None, B),
    ("-uf cluster is a force", "git push -uf origin feat/x", FEAT, None, B),
    ("-uf with force env still plain --force", "git push -uf origin feat/x", FEAT, FORCE, B),
    ("-vn cluster allowed", "git push -vn origin feat/x", FEAT, None, A),
    # --- I2: refspec normalisation ----------------------------------------------------
    ("wildcard refspec", "git push origin refs/heads/*:refs/heads/*", FEAT, None, B),
    ("HEAD:heads/master", "git push origin HEAD:heads/master", FEAT, None, B),
    ("HEAD:refs/heads/master", "git push origin HEAD:refs/heads/master", FEAT, None, B),
    ("empty refspec ':'", "git push origin :", FEAT, None, B),
    ("empty destination 'feat/x:'", "git push origin feat/x:", FEAT, None, B),
    ("--prune blocked", "git push --prune origin feat/x", FEAT, None, B),
    ("+master refspec", "git push origin +master", FEAT, None, B),
    ("+feat/x refspec is a force", "git push origin +feat/x", FEAT, None, B),
    ("+feat/x with force env allowed", "git push origin +feat/x", FEAT, FORCE, A),
    ("--force-with-lease=master:abc to master", "git push --force-with-lease=master:abc origin master", FEAT, FORCE, B),
    ("--force-with-lease=feat/x to feat/x with env", "git push --force-with-lease=feat/x origin feat/x", FEAT, FORCE, A),
    ("--force-with-lease=feat/x without env", "git push --force-with-lease=feat/x origin feat/x", FEAT, None, B),
    ("--delete master", "git push origin --delete master", FEAT, None, B),
    ("tag named like mainline is a tag, not the branch", "git push origin refs/tags/v1", FEAT, None, A),
    # By design mainline names are compared case-sensitively (git branch names are):
    # MASTER is a different branch from master, so pushing it is allowed.
    ("MASTER (case) is a different branch: allowed by design", "git push origin MASTER", FEAT, None, A),
    # --- I5: config overrides ---------------------------------------------------------
    ("git -c on push", "git -c core.sshCommand=x push origin feat/x", FEAT, None, B),
    ("git -c remote receivepack on push", "git -c remote.origin.receivepack=/bin/x push origin feat/x", FEAT, None, B),
    ("git -c on fetch", "git -c core.sshCommand=x fetch origin", FEAT, None, B),
    ("git -c on a read-only command allowed", "git -c color.ui=never log", FEAT, None, A),
    # --- I6: malformed mainline config ------------------------------------------------
    ("GIT_GUARD_MAINLINE='master main' splits on whitespace",
     "git push origin main", FEAT, {"GIT_GUARD_MAINLINE": "master main"}, B),
    ("GIT_GUARD_MAINLINE='master;main' rejects everything",
     "git status", FEAT, {"GIT_GUARD_MAINLINE": "master;main"}, B),
    ("GIT_GUARD_MAINLINE with empty name rejects everything",
     "git status", FEAT, {"GIT_GUARD_MAINLINE": "master,,main"}, B),
    # --- I7: operator tree worktree removal ------------------------------------------
    ("worktree remove --force of the operator tree", f"git worktree remove --force {OPTREE}", FEAT, FORCE, B),
    ("worktree remove of the operator tree", f"git worktree remove {OPTREE}", FEAT, FORCE, B),
    ("worktree prune from inside the operator tree", f"git -C {OPTREE} worktree prune", FEAT, FORCE, B),
    ("worktree remove of another path allowed", "git worktree remove /tmp/gg-other-wt", FEAT, FORCE, A),
    # --- wrappers: sh -c / bash -c / xargs / eval ---------------------------------------
    ("sh -c push to master", "sh -c 'git push origin master'", FEAT, None, B),
    ("bash -c push to master", 'bash -c "git push origin master"', FEAT, None, B),
    ("bash -lc push to master", 'bash -lc "git push origin master"', FEAT, None, B),
    ("xargs git push with stdin refspec", "xargs git push origin <<< master", FEAT, None, B),
    ("sh -c git status allowed", 'sh -c "git status"', FEAT, None, A),
    ("nested bash -c / sh -c push to master", """bash -c 'sh -c "git push origin master"'""", FEAT, None, B),
    ("eval push to master", "eval 'git push origin master'", FEAT, None, B),
    ("env wrapper push to master", "env FOO=1 git push origin master", FEAT, None, B),
    ("sudo/timeout wrapper push to master", "timeout 5 sudo git push origin HEAD:master", FEAT, None, B),
    ("sh -c with unbalanced inner quote fails closed", """sh -c 'git commit -m "x'""", FEAT, None, B),
    ("sh -c feature push allowed", "sh -c 'git push origin feat/x'", FEAT, None, A),
    ("xargs of a non-git command allowed", "ls | xargs echo", FEAT, None, A),
    # --- detached worktrees are open to every agent --------------------------------------
    ("detached worktree add outside operator tree, no env", "git worktree add --detach /tmp/gg-d1 HEAD", FEAT, None, A),
    ("worktree add of a branch without --detach, no env", "git worktree add /tmp/gg-d2 feat/x", FEAT, None, B),
    ("worktree add -b without env", "git worktree add -b newb /tmp/gg-d3", FEAT, None, B),
    ("worktree add --detach -b is a branch create: blocked without env", "git worktree add --detach -b newb /tmp/gg-d3 HEAD", FEAT, None, B),
    ("detached add inside operator tree subdir", f"git worktree add --detach {OPTREE}/sub HEAD", FEAT, None, B),
    ("worktree remove of a non-operator dir, no env", "git worktree remove /tmp/gg-d1", FEAT, None, A),
    ("worktree prune, no env", "git worktree prune", FEAT, None, A),
    ("worktree remove of operator tree, no env", f"git worktree remove {OPTREE}", FEAT, None, B),
]


def main():
    failures = 0
    for name, cmd, cwd, extra, expected in CASES:
        got = run(cmd, cwd, extra)
        ok = got == expected
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: exit={got} (expected {expected})")
        failures += not ok
    print(f"\n{len(CASES) - failures}/{len(CASES)} passed")
    return 1 if failures else 0


def test_all():
    assert main() == 0


if __name__ == "__main__":
    sys.exit(main())
