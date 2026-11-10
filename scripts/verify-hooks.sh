#!/usr/bin/env bash
# Proves the tracked hook settings work for a headless Claude run.
# Usage: verify-hooks.sh [<fleet-tree>]
# In a throwaway clone (of <fleet-tree> when given, else a fresh repo) with a bare
# "origin", a headless `claude -p` run is told to push to the mainline; the guard's
# denial text must appear. Then the completion-gate fixtures and the guard tests run.
# Uses the default Claude login unless CLAUDE_CONFIG_DIR is set. Exit 1 on any miss.
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-}"
fail=0
check() { if "${@:2}"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }
die() { echo "FAIL: $*" >&2; exit 1; }

SETTINGS="$KIT/hooks/claude-settings.json"
check "claude-settings.json parses as JSON" jq -e . "$SETTINGS" >/dev/null
export AGENTS_REPO="$KIT"
check "AGENTS_REPO set and points at the kit hooks" test -f "$AGENTS_REPO/hooks/git-guard.py"
command -v claude >/dev/null 2>&1 || die "claude is not on PATH; cannot run the headless hook check"
command -v jq >/dev/null 2>&1 || die "jq is not on PATH"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
G=(-c user.email=verify@example.invalid -c user.name=verify)
if [ -n "$SRC" ]; then
  git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1 || die "not a git tree: $SRC"
  git clone -q "$SRC" "$TMP/clone" || die "clone of $SRC failed"
  git clone -q --bare "$SRC" "$TMP/origin.git" || die "bare clone failed"
  git -C "$TMP/clone" remote set-url origin "$TMP/origin.git"
else
  git init -q --bare "$TMP/origin.git" || die "git init failed"
  git init -q "$TMP/clone" && git -C "$TMP/clone" "${G[@]}" commit -q --allow-empty -m root \
    && git -C "$TMP/clone" remote add origin "$TMP/origin.git" || die "scratch clone setup failed"
fi
mkdir -p "$TMP/operator"

OUT="$TMP/claude.out"
(
  cd "$TMP/clone" || exit 1
  PAPERCLIP_AGENT_ID=verify PRODUCT_OPERATOR_TREE="$TMP/operator" GIT_GUARD_MAINLINE=master,main \
    claude -p "Run exactly: git push --dry-run origin HEAD:master" --settings "$SETTINGS" --allowedTools Bash \
    </dev/null >"$OUT" 2>&1
) 
rc=$?
if [ ! -s "$OUT" ] || { [ $rc -ne 0 ] && ! grep -q "git-guard" "$OUT"; }; then
  echo "claude run did not complete (rc=$rc):" >&2; head -c 800 "$OUT" >&2
  die "headless claude run could not start (is it logged in? set CLAUDE_CONFIG_DIR)"
fi
check "guard denial text in the headless run output" grep -q "refusing to push to a mainline branch" "$OUT"
grep -qi "git-guard" "$OUT" || { echo "--- run output ---"; head -c 800 "$OUT"; }

check "completion-gate fixtures" bash "$KIT/hooks/test_completion_gate.sh"
for t in "$KIT"/hooks/test_git_guard_*.py; do
  check "$(basename "$t")" python3 "$t"
done
[ $fail = 0 ] && echo "verify-hooks: PASS" || echo "verify-hooks: FAIL"
exit $fail
