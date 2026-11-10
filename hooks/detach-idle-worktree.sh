#!/usr/bin/env bash
# SessionEnd hook — leave a fleet worktree on a DETACHED HEAD when an agent run ends.
#
# Environment read:
#   PRODUCT_FLEET_TREE  working tree the fleet agents run in.
#   PRODUCT_RETRO_TREE  working tree the retro agents run in.
# Only the session's project directory (CLAUDE_PROJECT_DIR, default $PWD) is touched, and
# only when it resolves to one of those two trees; anything else is a no-op.
#
# Why: a branch checked out in a worktree is LOCKED, so the operator can no longer
# `git checkout` it in their own tree ("already used by worktree at ..."). Detaching
# frees EVERY branch name (the just-finished review branch AND the mainline), so when
# the fleet is idle the operator can check out anything with a plain `git checkout`.
#
# We DETACH, never `git switch master`: switching to master would just move the lock
# onto master — the one branch the operator most needs free.
#
# Safe by construction (this hook runs outside the PreToolUse Bash path, so git-guard
# does not gate it — hence the guards below are our own safety net):
#   - no-op if HEAD is already detached
#   - no-op if the working tree has uncommitted TRACKED changes (never strand fleet work;
#     the run is expected to have committed to the feature branch before ending)
#   - untracked files are fine — `git checkout --detach` carries them along, loses nothing
#   - the branch ref is preserved at its tip; the next run re-switches to it to continue
set -uo pipefail

dir="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$dir" 2>/dev/null || exit 0

# Only act inside the configured fleet / retro trees.
here="$(pwd -P)"
managed=0
for t in "${PRODUCT_FLEET_TREE:-}" "${PRODUCT_RETRO_TREE:-}"; do
  [ -n "$t" ] || continue
  real="$(cd "$t" 2>/dev/null && pwd -P)" || continue
  [ "$here" = "$real" ] && managed=1
done
[ "$managed" -eq 1 ] || exit 0

# Not a git worktree? nothing to do.
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Already detached? nothing to do.
git symbolic-ref -q HEAD >/dev/null 2>&1 || exit 0

# Uncommitted tracked changes (staged or unstaged)? leave everything as-is.
if ! git diff --quiet --ignore-submodules -- || ! git diff --cached --quiet --ignore-submodules --; then
  echo "detach-idle-worktree: uncommitted changes in $dir — leaving branch checked out" >&2
  exit 0
fi

branch="$(git symbolic-ref --short -q HEAD || echo '?')"
git checkout --detach --quiet && \
  echo "detach-idle-worktree: detached $dir off '$branch' (branch freed for operator)" >&2
exit 0
