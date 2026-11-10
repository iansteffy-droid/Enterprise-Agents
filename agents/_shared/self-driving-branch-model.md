# Self-driving coding chain: the feature-branch model

**Why:** the chain must run end to end without the operator in the per-issue loop, while the mainline stays human-controlled. Agents therefore create and push their own feature branches; only a human merge changes the mainline.

## One feature = one feature branch = one PR
1. **The feature is the top-level ancestor issue.** Walk `parentId` up to the issue whose `parentId` is `null`; that issue owns the one feature branch, named by the profile's branch scheme (`## Branching` → `scheme:`). Any issue with a `parentId` is a subtask, however independent its work looks. An agent never promotes a subtask to a standalone feature at branch or merge time; re-parenting is an explicit decision made up front.
2. **All work for the feature lands on that branch** (implementation, fixes, follow-ups), with one PR. Never cut a new branch off the mainline for a fix to an existing feature. One branch per feature keeps the operator looking at one PR, not a scatter of fragments.
3. **Sub-branches, when used at all, branch off the feature branch, merge back into it, and are deleted** (`git branch -d`) right after. A sub-branch never merges into the mainline and never outlives its merge-back. One developer on one feature just works on the feature branch.
4. **Start from the current base and reconcile at hand-off.** Fetch, branch off the up-to-date base, and merge the base into the feature branch before handing off, so a stale base surfaces as a conflict you fix, not one the operator finds at PR time.

## The mainline is never touched by agents
The mainline named in the profile (`$GIT_GUARD_MAINLINE`) is never committed to, merged into, switched to, reset or pushed by an agent. It changes only when a human merges the feature branch's PR. An agent's terminal deliverable is "feature branch ready + PR", never a local land.

Agents **may push any non-mainline branch**. git-guard enforces the mainline rule; it is a safety net, not a sandbox, so the rule holds even where the guard would not catch a violation.

## Review runs on the assembled feature
The feature's review chain runs on the feature branch after all sub-work is merged into it: you cannot certify a feature you have not checked assembled.

## Prepare for merge: operator-triggered, never automatic
Nothing squashes automatically. When the operator triggers "prepare branch for merge", the branch-hygiene agent, in place if the branch is the clean checked-out one and otherwise in a temporary worktree on the feature branch (`git worktree add <dir> <feature>`, not detached; removed before the run ends, see Worktree hygiene):
1. rebases the feature branch onto the current base, only if it is behind (on a real conflict: `git rebase --abort`, then `request_changes` with the conflicting files when it is the feature's current review participant, otherwise a handoff per `_shared/board-decision-handoff.md` with `Operator action needed:` listing them);
2. squashes it to one Conventional Commit;
3. pushes **the feature branch only**, with `git push --force-with-lease`.

It never pushes, checks out or touches the mainline. The human's remaining step is merging the PR.

## Worktree hygiene
A branch checked out in any worktree is locked for every other checkout, including the operator's. So:
- A temporary worktree used only to build, test or inspect is created **detached**: `git worktree add --detach <dir> <ref>`.
- A temporary worktree you committed from is removed before your run ends, on success or failure: `git worktree remove <dir> && git worktree prune`.
- Never end a run with a branch checked out in a temporary worktree.
