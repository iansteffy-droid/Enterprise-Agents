#!/usr/bin/env bash
# fleet-worktree-to-clone.sh: convert a LINKED git worktree (a client's fleet tree) into an
# INDEPENDENT clone, in place, keeping its branch, index (staged work), unstaged edits,
# untracked files and reflog exactly as they are.
#
# Why: a branch checked out in a linked worktree is locked repo-wide, so the operator gets
#   fatal: '<branch>' is already used by worktree at '<fleet tree>'
# in their own tree. Detaching the fleet when idle only helps between runs. Two separate
# repositories share no branch lock, so the operator can check out any branch at any time;
# work flows between the trees through `origin` (the fleet pushes) or the fetch-only local
# remote this script adds to the operator's tree:
#   git fetch <remote> && git merge --ff-only <remote>/<branch>
#
# Usage:  fleet-worktree-to-clone.sh <operator-tree> <fleet-worktree> [remote-name] [backup-dir]
#         operator-tree  the client's operator clone (e.g. <code-root>/<client>)
#         fleet-worktree its linked fleet worktree (e.g. <code-root>/<client>-fleet)
#         remote-name    fetch-only remote added to the operator tree (default: fleet)
#         backup-dir     where the old worktree link file and worktree metadata are MOVED
#                        (default: a fresh dir under ${TMPDIR:-/tmp}, printed at the end).
#                        Nothing is deleted: remove the backup yourself once satisfied.
#         DRY_RUN=1 fleet-worktree-to-clone.sh ...   prints the plan and exits 0.
# All local, no network. Refuses to run if the fleet is already standalone. Verifies
# HEAD, branch and `git status` are identical before/after and rolls back otherwise.
set -euo pipefail

USAGE="usage: $0 <operator-tree> <fleet-worktree> [remote-name] [backup-dir]"
MAIN=$(realpath "${1:?$USAGE}")
FLEET=$(realpath "${2:?$USAGE}")
REMOTE=${3:-fleet}
BAK=${4:-}
DRY=${DRY_RUN:-0}

say() { printf '%s\n' "$*" >&2; }
die() { say "ERROR: $*"; exit 1; }

# --- preflight -----------------------------------------------------------------
[ -d "$MAIN/.git" ] || die "$MAIN is not a repository root"
[ -f "$FLEET/.git" ] || die "$FLEET/.git is not a worktree link file (already standalone?)"
WT_META=$(sed -n 's/^gitdir: //p' "$FLEET/.git")
[ -n "$WT_META" ] && [ -d "$WT_META" ] || die "worktree metadata '$WT_META' missing"
case "$WT_META" in "$MAIN/.git/worktrees/"*) ;; *) die "$FLEET is not a worktree of $MAIN (gitdir=$WT_META)";; esac
[ -z "$BAK" ] || [ ! -e "$BAK" ] || die "backup dir $BAK already exists"

ORIGIN_URL=$(git -C "$MAIN" remote get-url origin)
BEFORE_SHA=$(git -C "$FLEET" rev-parse HEAD)
BEFORE_REF=$(git -C "$FLEET" symbolic-ref -q HEAD || echo DETACHED)
BEFORE_STATUS=$(git -C "$FLEET" status --porcelain --untracked-files=all | sort)

say "operator tree : $MAIN"
say "fleet worktree: $FLEET  (metadata $WT_META)"
say "fleet HEAD    : $BEFORE_SHA  $BEFORE_REF"
say "origin        : $ORIGIN_URL"
say "remote name   : $REMOTE"
if [ "$DRY" = 1 ]; then say "DRY_RUN — stopping before any change"; exit 0; fi
if [ -z "$BAK" ]; then BAK=$(mktemp -d "${TMPDIR:-/tmp}/fleet-worktree-to-clone.$(basename "$FLEET").XXXXXX"); else mkdir -p "$BAK"; fi
say "backup dir    : $BAK"

# --- 1. independent object store (same filesystem → hardlinked packs, seconds) ------
# $TMP holds only the new .git until the swap; it is removed with rmdir on success and
# left in place (and named) if anything goes wrong — nothing here ever deletes recursively.
TMP=$(mktemp -d "${FLEET}.clone.XXXXXX")
git clone --quiet --no-checkout --local "$MAIN" "$TMP"

# --- 2. refs: real origin/* (not the operator's local branches), every local branch ----
git -C "$TMP" remote set-url origin "$ORIGIN_URL"
PUSH_URL=$(git -C "$MAIN" remote get-url --push origin 2>/dev/null || true)
if [ -n "$PUSH_URL" ] && [ "$PUSH_URL" != "$ORIGIN_URL" ]; then
  git -C "$TMP" remote set-url --push origin "$PUSH_URL"
fi
# a local clone lists the operator's LOCAL branches as origin/* — replace them with the
# operator tree's actual remote-tracking refs
git -C "$TMP" for-each-ref --format='%(refname)' refs/remotes/origin/ | grep -v '/HEAD$' \
  | while read -r r; do git -C "$TMP" update-ref -d "$r"; done
git -C "$MAIN" for-each-ref --format='%(objectname) %(refname)' refs/remotes/origin/ | grep -v '/HEAD$' \
  | while read -r sha ref; do git -C "$TMP" update-ref "$ref" "$sha"; done
OH=$(git -C "$MAIN" symbolic-ref -q refs/remotes/origin/HEAD || true)
if [ -n "$OH" ]; then git -C "$TMP" symbolic-ref refs/remotes/origin/HEAD "$OH"; fi
# every local branch keeps existing in the fleet (feature branches, backups) so a run can resume it
git -C "$MAIN" for-each-ref --format='%(objectname) %(refname)' refs/heads/ \
  | while read -r sha ref; do git -C "$TMP" update-ref "$ref" "$sha"; done

# --- 3. config and excludes the worktree inherited from the operator tree -------------
for k in user.name user.email pull.rebase rebase.updaterefs core.autocrlf core.filemode push.autosetupremote; do
  v=$(git -C "$MAIN" config --local --get "$k" || true)
  if [ -n "$v" ]; then git -C "$TMP" config "$k" "$v"; fi
done
if [ -f "$MAIN/.git/info/exclude" ]; then mkdir -p "$TMP/.git/info"; cp -a "$MAIN/.git/info/exclude" "$TMP/.git/info/exclude"; fi

# --- 4. swap in place (moves only); carry the per-worktree state over unchanged ----------
mv "$FLEET/.git" "$BAK/worktree-link"
mv "$TMP/.git" "$FLEET/.git"
for f in HEAD ORIG_HEAD MERGE_HEAD MERGE_MSG MERGE_MODE CHERRY_PICK_HEAD REVERT_HEAD FETCH_HEAD COMMIT_EDITMSG index; do
  if [ -e "$WT_META/$f" ]; then cp -a "$WT_META/$f" "$FLEET/.git/$f"; fi
done
if [ -d "$WT_META/logs" ]; then mkdir -p "$FLEET/.git/logs"; cp -a "$WT_META/logs/." "$FLEET/.git/logs/"; fi
if [ -d "$WT_META/refs" ]; then cp -a "$WT_META/refs/." "$FLEET/.git/refs/"; fi

# --- 5. verify, else roll back ----------------------------------------------------
AFTER_SHA=$(git -C "$FLEET" rev-parse HEAD)
AFTER_REF=$(git -C "$FLEET" symbolic-ref -q HEAD || echo DETACHED)
AFTER_STATUS=$(git -C "$FLEET" status --porcelain --untracked-files=all | sort)
COMMON=$(git -C "$FLEET" rev-parse --path-format=absolute --git-common-dir)
if [ "$AFTER_SHA" != "$BEFORE_SHA" ] || [ "$AFTER_REF" != "$BEFORE_REF" ] \
   || [ "$AFTER_STATUS" != "$BEFORE_STATUS" ] || [ "$(realpath "$COMMON")" != "$FLEET/.git" ]; then
  say "verification FAILED — rolling back (HEAD $AFTER_SHA ref $AFTER_REF common-dir $COMMON)"
  diff <(printf '%s\n' "$BEFORE_STATUS") <(printf '%s\n' "$AFTER_STATUS") >&2 || true
  mv "$FLEET/.git" "$TMP/.git"
  mv "$BAK/worktree-link" "$FLEET/.git"
  die "rolled back; nothing changed (leftover clone attempt in $TMP and backup dir $BAK — safe to delete)"
fi

# --- 6. operator tree: forget the worktree (metadata MOVED to the backup), fetch-only remote
mv "$WT_META" "$BAK/worktree-meta"
git -C "$MAIN" worktree prune
if git -C "$MAIN" worktree list --porcelain | grep -qx "worktree $FLEET"; then
  die "operator tree still lists $FLEET as a worktree"
fi
if ! git -C "$MAIN" remote get-url "$REMOTE" >/dev/null 2>&1; then git -C "$MAIN" remote add "$REMOTE" "$FLEET"; fi
git -C "$MAIN" remote set-url --push "$REMOTE" no_push
rmdir "$TMP"

say "done: $FLEET is an independent clone on $AFTER_REF @ $AFTER_SHA (work preserved)."
say "backup of the old worktree link + metadata: $BAK  (delete when satisfied)"
say "operator: any branch can be checked out in $MAIN now. Fleet work arrives via"
say "  git fetch $REMOTE && git merge --ff-only $REMOTE/<branch>     (or, once the fleet pushed: git fetch origin)"
