#!/usr/bin/env bash
# Usage: validate-profile.sh <profile.md>
# Exit 0 when every required heading, Commands row, Branching key and Limits key is present
# and every command row has cost fast|slow and ci yes|no. Prints the first problem found.
set -uo pipefail
f="${1:-}"
[ -n "$f" ] && [ -f "$f" ] || { echo "usage: validate-profile.sh <profile.md> (file not found: $f)" >&2; exit 1; }

awk '
function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
function fail(msg) { print "INVALID: " msg; bad = 1; exit 1 }
BEGIN {
  nh = split("## Stack|## Workspaces|## Commands|## Services|## Test conventions|## House rules|## Security paths|## Dev data policy|## CI|## Branching|## Limits", H, "|")
  nr = split("build|typecheck|lint|static-lint|format-policy|integration|e2e", R, "|")
}
{ sub(/\r$/, "") }
/^# Profile: / { name = 1 }
/^## / { sec = trim($0); seen[sec] = 1; next }
sec == "## Commands" && /^\|/ {
  n = split($0, c, "|")
  step = trim(c[2]); cost = trim(c[n - 2]); ci = trim(c[n - 1])
  if (step == "step" || step ~ /^-+$/ || step ~ /^:?-+:?$/) next
  rows[step] = 1
  cmd = trim(c[3])
  if (cmd == "" || cmd ~ /^`?<[^>]*>`?$/) fail("line " NR ": row \"" step "\" has an empty or placeholder command")
  if (step ~ /^unit:./) unit = 1
  if (cost != "fast" && cost != "slow") fail("line " NR ": row \"" step "\" has invalid cost \"" cost "\" (fast|slow)")
  if (ci != "yes" && ci != "no") fail("line " NR ": row \"" step "\" has invalid ci \"" ci "\" (yes|no)")
}
sec == "## Branching" && /^(- )?`?mainline:/ { bm = 1 }
sec == "## Branching" && /^(- )?`?scheme:/ { bs = 1 }
sec == "## Limits" {
  line = $0; sub(/^- /, "", line); gsub(/`/, "", line)
  if (line ~ /^(ci_wait_minutes|qa_run_minutes):/) {
    key = line; sub(/:.*/, "", key); val = line; sub(/^[^:]*:/, "", val); val = trim(val)
    if (val !~ /^[0-9]+$/) fail("line " NR ": " key " must be an integer, got \"" val "\"")
    lim[key] = 1
  }
}
END {
  if (bad) exit 1
  if (!name) fail("missing heading: # Profile: <name>")
  for (i = 1; i <= nh; i++) if (!(H[i] in seen)) fail("missing heading: " H[i])
  for (i = 1; i <= nr; i++) if (!(R[i] in rows)) fail("missing row in ## Commands: " R[i])
  if (!unit) fail("missing row in ## Commands: unit:<workspace>")
  if (!bm) fail("missing key in ## Branching: mainline:")
  if (!bs) fail("missing key in ## Branching: scheme:")
  if (!("ci_wait_minutes" in lim)) fail("missing key in ## Limits: ci_wait_minutes")
  if (!("qa_run_minutes" in lim)) fail("missing key in ## Limits: qa_run_minutes")
}' "$f"
rc=$?
[ "$rc" = 0 ] && echo "OK: $f"
exit "$rc"
