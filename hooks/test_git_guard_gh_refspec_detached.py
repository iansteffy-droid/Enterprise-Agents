#!/usr/bin/env python3
"""Tests for the git-guard gh policy, unresolvable push refspecs and detached commits.

Run: python3 hooks/test_git_guard_gh_refspec_detached.py   Exit 0 = all pass, 1 = a failure.
"""
import json
import os
import subprocess
import sys
import tempfile

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "git-guard.py")


def _git(d, *args):
    subprocess.run(["git", *args], cwd=d, check=True, capture_output=True)


def make_repo(branch=None, detached=False):
    d = tempfile.mkdtemp(prefix="gg-gh-")
    _git(d, "init", "-q")
    _git(d, "config", "user.email", "t@t")
    _git(d, "config", "user.name", "t")
    _git(d, "commit", "-q", "--allow-empty", "-m", "root")
    if branch:
        _git(d, "checkout", "-q", "-b", branch)
    if detached:
        _git(d, "switch", "-q", "--detach")
    return d


FEAT = make_repo("feat/x")
with open(os.path.join(FEAT, "mutation.graphql"), "w") as fh:
    fh.write('mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }')
FLEET_DETACHED = make_repo("feat/y", detached=True)
OTHER_DETACHED = make_repo("feat/z", detached=True)


def run(cmd, cwd=FEAT, extra=None):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("GIT_GUARD_") and k not in ("PRODUCT_OPERATOR_TREE", "PRODUCT_FLEET_TREE")}
    env["PAPERCLIP_AGENT_ID"] = "any-agent-id"
    env.update(extra or {})
    payload = json.dumps({"tool_input": {"command": cmd}, "cwd": cwd})
    r = subprocess.run([sys.executable, HOOK], input=payload, env=env, capture_output=True, text=True)
    return r.returncode, r.stderr


FLEET = {"PRODUCT_FLEET_TREE": FLEET_DETACHED}

CASES = [
    # gh: blocked forms
    ("gh pr merge blocked", "gh pr merge 5 --squash", FEAT, None, 2),
    ("gh pr merge with -R before blocked", "gh -R o/r pr merge 5", FEAT, None, 2),
    ("gh repo delete blocked", "gh repo delete o/r --yes", FEAT, None, 2),
    ("gh api PUT pulls/5/merge blocked", "gh api -X PUT repos/o/r/pulls/5/merge", FEAT, None, 2),
    ("gh api --method DELETE git/refs blocked", "gh api --method DELETE repos/o/r/git/refs/heads/x", FEAT, None, 2),
    ("gh api --method=PATCH git/refs blocked", "gh api --method=PATCH repos/o/r/git/refs/heads/main -f sha=abc", FEAT, None, 2),
    ("gh api -XPOST merges blocked", "gh api -XPOST repos/o/r/merges -f base=main -f head=x", FEAT, None, 2),
    ("gh api PUT branch protection blocked", "gh api -X PUT repos/o/r/branches/main/protection --input p.json", FEAT, None, 2),
    ("gh api implicit POST (fields) on git/refs blocked", "gh api repos/o/r/git/refs -f ref=refs/heads/x -f sha=abc", FEAT, None, 2),
    ("gh api DELETE branches blocked", "gh api -X DELETE repos/o/r/branches/x", FEAT, None, 2),
    ("gh pr merge inside sh -c blocked", "sh -c 'gh pr merge 5'", FEAT, None, 2),
    ("gh pr -R o/r merge blocked", "gh pr -R o/r merge 5", FEAT, None, 2),
    ("gh pr --repo o/r merge blocked", "gh pr --repo o/r merge 5 --squash", FEAT, None, 2),
    ("gh pr --repo=o/r merge blocked", "gh pr --repo=o/r merge 5", FEAT, None, 2),
    ("gh repo -R o/r delete blocked", "gh repo --hostname h delete o/r --yes", FEAT, None, 2),
    ("gh pr create titled merge blocked", "gh pr create --title merge --body b", FEAT, None, 2),
    ("gh pr -R o/r view allowed", "gh pr -R o/r view 5", FEAT, None, 0),
    ("gh api graphql mergePullRequest blocked",
     "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'", FEAT, None, 2),
    ("gh api graphql deleteRef blocked", "gh api graphql -f query='mutation { deleteRef(input: {refId: \"r\"}) { clientMutationId } }'", FEAT, None, 2),
    ("gh api graphql updateRef blocked (glued -f)", "gh api graphql -fquery='mutation { updateRef(input: {refId: \"r\", oid: \"o\"}) { clientMutationId } }'", FEAT, None, 2),
    ("gh api graphql mutation from -F query=@file blocked", "gh api graphql -F query=@mutation.graphql", FEAT, None, 2),
    ("gh api graphql mutation from --input file blocked", "gh api graphql --input mutation.graphql", FEAT, None, 2),
    ("gh api graphql unreadable body file blocked", "gh api graphql -F query=@missing.graphql", FEAT, None, 2),
    ("gh api graphql query allowed", "gh api graphql -f query='query { viewer { login } }'", FEAT, None, 0),
    # gh: allowed forms
    ("gh pr create blocked", "gh pr create --title t --body b --base main", FEAT, None, 2),
    ("gh -R o/r pr create blocked", "gh -R o/r pr create --fill", FEAT, None, 2),
    ("gh pr new blocked", "gh pr new --fill", FEAT, None, 2),
    ("gh pr edit blocked", "gh pr edit 5 --title x", FEAT, None, 2),
    ("gh pr close blocked", "gh pr close 5", FEAT, None, 2),
    ("gh pr reopen blocked", "gh pr reopen 5", FEAT, None, 2),
    ("gh pr ready blocked", "gh pr ready 5", FEAT, None, 2),
    ("gh pr create inside sh -c blocked", "sh -c 'gh pr create --fill'", FEAT, None, 2),
    ("gh api POST pulls blocked", "gh api repos/o/r/pulls -f title=t -f head=a -f base=main", FEAT, None, 2),
    ("gh api PATCH pulls/5 blocked", "gh api -X PATCH repos/o/r/pulls/5 -f state=closed", FEAT, None, 2),
    ("gh api graphql createPullRequest blocked", "gh api graphql -f query='mutation { createPullRequest(input: {}) { clientMutationId } }'", FEAT, None, 2),
    ("hub pull-request blocked", "hub pull-request -m t", FEAT, None, 2),
    ("gh api GET pulls list allowed", "gh api repos/o/r/pulls --paginate", FEAT, None, 0),
    ("gh pr list allowed", "gh pr list --head feat/x", FEAT, None, 0),
    ("gh pr diff allowed", "gh pr diff 5", FEAT, None, 0),
    ("gh pr checks allowed", "gh pr checks 5", FEAT, None, 0),
    ("gh run list allowed", "gh run list --limit 5", FEAT, None, 0),
    ("gh api GET pulls/5 allowed", "gh api repos/x/y/pulls/5", FEAT, None, 0),
    ("gh api GET branches allowed", "gh api repos/x/y/branches", FEAT, None, 0),
    ("gh api POST issue comment allowed", "gh api -X POST repos/x/y/issues/5/comments -f body=hi", FEAT, None, 0),
    ("gh pr view allowed", "gh pr view 5 --json state", FEAT, None, 0),
    # push: unresolvable remote or refspec
    ("push of a shell variable blocked", 'BRANCH=main; git push -u origin "$BRANCH"', FEAT, None, 2),
    ("push of an unquoted variable blocked", "git push origin $BRANCH", FEAT, None, 2),
    ("push of a $(...) substitution blocked", 'git push -u origin "$(git branch --show-current)"', FEAT, None, 2),
    ("push of an unquoted $(...) blocked", "git push -u origin $(git branch --show-current)", FEAT, None, 2),
    ("push of a backtick substitution blocked", "git push -u origin `git branch --show-current`", FEAT, None, 2),
    ("push to a variable remote blocked", 'git push "$REMOTE" feat/x', FEAT, None, 2),
    ("push -u origin HEAD on a feature branch allowed", "git push -u origin HEAD", FEAT, None, 0),
    ("commit message with backticks then push HEAD allowed",
     'git commit -q --allow-empty -m "fix the `parser`" && git push -u origin HEAD', FEAT, None, 0),
    # commit on a detached HEAD
    ("commit on a detached HEAD in the fleet tree blocked", "git commit -m x", FLEET_DETACHED, FLEET, 2),
    ("git -C fleet commit on a detached HEAD blocked", "git -C %s commit -m x" % FLEET_DETACHED, FEAT, FLEET, 2),
    ("commit on a branch in the fleet tree allowed", "git commit -m x", FEAT, {"PRODUCT_FLEET_TREE": FEAT}, 0),
    ("commit on a detached HEAD outside the fleet tree allowed", "git commit -m x", OTHER_DETACHED, FLEET, 0),
    ("add on a detached HEAD in the fleet tree allowed", "git add -A", FLEET_DETACHED, FLEET, 0),
    # detach in place after a push (no branch stays checked out)
    ("bare git switch --detach allowed", "git switch --detach", FEAT, None, 0),
    ("git switch --detach <ref> still blocked", "git switch --detach main", FEAT, None, 2),
    ("git checkout --detach still blocked", "git checkout --detach", FEAT, None, 2),
    ("git switch --detach in the operator tree blocked", "git switch --detach", FEAT, {"PRODUCT_OPERATOR_TREE": FEAT}, 2),
]


def main():
    fails = 0
    for name, cmd, cwd, extra, want in CASES:
        rc, err = run(cmd, cwd, extra)
        ok = rc == want
        print(("[PASS] " if ok else "[FAIL] ") + name + ("" if ok else ": rc=%d want=%d %s" % (rc, want, err.strip())))
        fails += 0 if ok else 1
    # Messages name no branch prefix and no remote mainline.
    _, err = run('git push origin "$BRANCH"')
    _, err2 = run("git commit -m x", FLEET_DETACHED, FLEET)
    _, err3 = run("git switch main")
    for label, e in (("push", err), ("detached", err2), ("switch", err3)):
        ok = e and "pc/" not in e and "origin/master" not in e
        print(("[PASS] " if ok else "[FAIL] ") + "%s message is generic" % label + ("" if ok else ": " + e))
        fails += 0 if ok else 1
    print("%d/%d passed" % (len(CASES) + 3 - fails, len(CASES) + 3))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
