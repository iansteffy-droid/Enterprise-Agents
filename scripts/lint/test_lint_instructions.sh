#!/usr/bin/env bash
# Tests for scripts/lint-instructions.sh: real exit codes and output.
# The kit ships no banned-term list: every run here uses a neutral test list written to a
# temp dir and passed through LINT_BANNED_TERMS_DIR (terms acmecorp, widgetco; pattern
# \bWIDGET-[0-9]+), never the operator's private lists.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LINT="$ROOT/scripts/lint-instructions.sh"
FX="$HERE/fixtures"
fails=0
TMPS=()
LISTS="$(mktemp -d)"
cleanup() { [ ${#TMPS[@]} -gt 0 ] && rm -f "${TMPS[@]}"; rm -rf "$LISTS"; }
trap cleanup EXIT

# Neutral test lists. local-board is Paperclip's own actor id (not a private term): it is in
# the list so the paperclip/ exemption below can be tested.
printf 'acmecorp\nwidgetco\nlocal-board\n' > "$LISTS/banned-terms.txt"
printf '\\bWIDGET-[0-9]+\n' > "$LISTS/banned-patterns.txt"
export LINT_BANNED_TERMS_DIR="$LISTS"

check() { # name, condition-result
  if [ "$2" = 0 ]; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails+1)); fi
}

for f in "$FX"/fail-*.md; do
  rule="$(basename "$f" .md)"; rule="${rule#fail-}"
  [ "$rule" = "board" ] && rule="board-literal"
  out="$("$LINT" "$f" 2>&1)"; rc=$?
  [ $rc = 1 ] && printf '%s' "$out" | grep -q ": $rule: "
  check "fixture fail-$rule exits 1 with rule '$rule'" $?
done

"$LINT" "$FX/pass.md" >/dev/null 2>&1
check "fixture pass exits 0" $?

# ---- lists not installed ----
MSG='banned-term lists not installed: copy them to'
err="$(LINT_BANNED_TERMS_DIR="$LISTS/missing-dir" "$LINT" "$FX/pass.md" 2>&1 >/dev/null)"; rc=$?
[ $rc = 2 ] && printf '%s' "$err" | grep -qF "$MSG $LISTS/missing-dir (see README)"
check "missing list dir exits 2 with the install message" $?
ONLY_T="$(mktemp -d)"; ONLY_P="$(mktemp -d)"
cp "$LISTS/banned-terms.txt" "$ONLY_T/"; cp "$LISTS/banned-patterns.txt" "$ONLY_P/"
err="$(LINT_BANNED_TERMS_DIR="$ONLY_T" "$LINT" "$FX/pass.md" 2>&1 >/dev/null)"; rc=$?
[ $rc = 2 ] && printf '%s' "$err" | grep -qF "$MSG"
check "missing banned-patterns.txt exits 2 with the install message" $?
err="$(LINT_BANNED_TERMS_DIR="$ONLY_P" "$LINT" "$FX/pass.md" 2>&1 >/dev/null)"; rc=$?
[ $rc = 2 ] && printf '%s' "$err" | grep -qF "$MSG"
check "missing banned-terms.txt exits 2 with the install message" $?
rm -rf "$ONLY_T" "$ONLY_P"
err="$(HOME="$LISTS/no-home" LINT_BANNED_TERMS_DIR= "$LINT" "$FX/pass.md" 2>&1 >/dev/null)"; rc=$?
[ $rc = 2 ] && printf '%s' "$err" | grep -qF "$MSG $LISTS/no-home/.paperclip-enterprise/lint"
check "default dir is \$HOME/.paperclip-enterprise/lint" $?
[ ! -e "$HERE/banned-terms.txt" ] && [ ! -e "$HERE/banned-patterns.txt" ]
check "the kit ships no banned-term list" $?

# ---- default scan ----
TMPS+=("$ROOT/docs/.tmp-lint-test.md" "$ROOT/clients/.tmp-lint-test.md")
mkdir -p "$ROOT/clients"
echo "mentions acmecorp here" > "$ROOT/docs/.tmp-lint-test.md"
echo "mentions acmecorp here" > "$ROOT/clients/.tmp-lint-test.md"
out="$("$LINT" 2>&1)"; rc=$?
[ $rc = 1 ] && printf '%s' "$out" | grep -q 'docs/.tmp-lint-test.md:1: banned:' && ! printf '%s' "$out" | grep -q 'clients/'
check "default scan: banned term in docs/ exits 1, clients/ ignored" $?
rm -f "$ROOT/docs/.tmp-lint-test.md"
"$LINT" >/dev/null 2>&1
check "default scan: banned term only under clients/ exits 0" $?
"$LINT" "$ROOT/clients/.tmp-lint-test.md" >/dev/null 2>&1
check "explicit clients/ path is still excluded" $?

# Git-ignored files (a session allowlist, runtime state) are not part of the default scan;
# passed explicitly they are linted like any other file.
IGN="$ROOT/paperclip/.paperclip/.tmp-lint-ignored.md"; TMPS+=("$IGN")
mkdir -p "$(dirname "$IGN")"; echo "mentions acmecorp here" > "$IGN"
git -C "$ROOT" check-ignore -q "$IGN"
check "fixture: the ignored-file fixture is git-ignored" $?
"$LINT" >/dev/null 2>&1
check "default scan: a git-ignored file with a banned term is not scanned" $?
out="$("$LINT" "$IGN" 2>&1)"; rc=$?
[ $rc = 1 ] && printf '%s' "$out" | grep -q '.tmp-lint-ignored.md:1: banned:'
check "explicit path: a git-ignored file is linted" $?
rm -f "$IGN"
echo "mentions acmecorp here" > "$ROOT/docs/.tmp-lint-untracked.md"; TMPS+=("$ROOT/docs/.tmp-lint-untracked.md")
"$LINT" 2>&1 | grep -q 'docs/.tmp-lint-untracked.md:1: banned:'
check "default scan: an untracked, not-ignored file is still scanned" $?
rm -f "$ROOT/docs/.tmp-lint-untracked.md"

printf 'a\nb\nThis is non-blocking.\nc\nd\nwe approve it\n' > "$FX/../.tmp-carve.md"
TMPS+=("$HERE/.tmp-carve.md")
"$LINT" "$HERE/.tmp-carve.md" 2>&1 | grep -q ': carveout: '
check "non-blocking within 3 lines of approve flagged" $?
printf 'This is non-blocking.\nb\nc\nd\ne\nwe approve it\n' > "$HERE/.tmp-carve.md"
"$LINT" "$HERE/.tmp-carve.md" >/dev/null 2>&1
check "non-blocking 5 lines from approve not flagged" $?

# Blank and CRLF lines in the terms file must not break matching.
CRLF="$(mktemp -d)"
printf 'alpha-term\r\n\r\n\n  \nbeta-term\n\n' > "$CRLF/banned-terms.txt"
cp "$LISTS/banned-patterns.txt" "$CRLF/"
printf 'clean line\nnothing here\n' > "$HERE/.tmp-clean.md"; TMPS+=("$HERE/.tmp-clean.md")
printf 'clean\nhas ALPHA-TERM inside\nclean\nbeta-term\n' > "$HERE/.tmp-hit.md"; TMPS+=("$HERE/.tmp-hit.md")
LINT_BANNED_TERMS_DIR="$CRLF" "$LINT" "$HERE/.tmp-clean.md" >/dev/null 2>&1
check "blank/CRLF terms file does not flag a clean file" $?
out="$(LINT_BANNED_TERMS_DIR="$CRLF" "$LINT" "$HERE/.tmp-hit.md" 2>&1)"; rc=$?
[ $rc = 1 ] && [ "$(printf '%s' "$out" | wc -l)" = 1 ] && printf '%s' "$out" | grep -q 'tmp-hit.md:2: banned:' && printf '%s' "$out" | grep -q 'tmp-hit.md:4: banned:'
check "blank/CRLF terms file flags exactly the real hits" $?
rm -rf "$CRLF"

# ---- scope, patterns, exclusions ----
PCD="$ROOT/paperclip"; PCCREATED=0
[ -d "$PCD" ] || { mkdir -p "$PCD"; PCCREATED=1; }
PT="$PCD/.tmp-lint"; mkdir -p "$PT"; TMPS+=("$PT/a.md" "$PT/b.md" "$PT/lock/pnpm-lock.yaml" "$PT/storybook-static/x.md" "$PT/pat.md")
cleanup_pc() { rm -rf "$PT"; [ "$PCCREATED" = 1 ] && rmdir "$PCD" 2>/dev/null; }
trap 'cleanup; cleanup_pc' EXIT

printf 'id 12345678-1234-4234-8234-123456789abc at /home/foo and local-board\n' > "$PT/a.md"
"$LINT" "$PT/a.md" >/dev/null 2>&1
check "paperclip/: instruction rules (uuid, abspath, local-board) do not apply" $?
printf 'x\nlocal-board\n' > "$HERE/.tmp-lb.md"; TMPS+=("$HERE/.tmp-lb.md")
"$LINT" "$HERE/.tmp-lb.md" 2>&1 | grep -q ': banned: '
check "outside paperclip/: local-board is banned" $?
printf 'uses WidgetCo here\n' > "$PT/b.md"
"$LINT" "$PT/b.md" 2>&1 | grep -q ': banned: '
check "paperclip/: banned terms still apply (case-insensitive)" $?
printf 'ticket WIDGET-123\nsee WIDGET-7 too\n' > "$PT/pat.md"
out="$("$LINT" "$PT/pat.md" 2>&1)"; n="$(printf '%s\n' "$out" | grep -c ': banned: ')"
[ "$n" = 2 ]
check "patterns: each WIDGET-n is a banned hit ($n)" $?
printf 'SUBWIDGET-1 widget-1 WIDGET-x WIDGETS\n' > "$PT/pat.md"
"$LINT" "$PT/pat.md" >/dev/null 2>&1
check "patterns: boundaries and case-sensitivity avoid false positives" $?
mkdir -p "$PT/lock" "$PT/storybook-static"
echo 'integrity: sha512-xxacmecorpxx widgetco' > "$PT/lock/pnpm-lock.yaml"
"$LINT" "$PT/lock/pnpm-lock.yaml" >/dev/null 2>&1
check "lockfiles are skipped by banned rule" $?
echo 'acmecorp' > "$PT/storybook-static/x.md"
"$LINT" "$PT/storybook-static/x.md" >/dev/null 2>&1
check "storybook-static is excluded like dist" $?

# Empty patterns file fails closed; CRLF/blank handling.
PATD="$(mktemp -d)"; cp "$LISTS/banned-terms.txt" "$PATD/"; : > "$PATD/banned-patterns.txt"
LINT_BANNED_TERMS_DIR="$PATD" "$LINT" "$FX/pass.md" >/dev/null 2>&1; [ $? = 2 ]
check "empty patterns file exits 2" $?
printf '\r\n\n\\bZED-[0-9]+\r\n  \n' > "$PATD/banned-patterns.txt"
printf 'ok\nZED-9\nzed-9\n' > "$HERE/.tmp-hit.md"
out="$(LINT_BANNED_TERMS_DIR="$PATD" "$LINT" "$HERE/.tmp-hit.md" 2>&1)"; rc=$?
[ $rc = 1 ] && [ "$(printf '%s\n' "$out" | wc -l)" = 1 ] && printf '%s' "$out" | grep -q 'tmp-hit.md:2: banned:'
check "patterns file: blank/CRLF tolerated, case-sensitive match" $?
rm -rf "$PATD"

[ $fails = 0 ] && echo "ALL PASS" || echo "$fails FAILED"
[ $fails = 0 ]
