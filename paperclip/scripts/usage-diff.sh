#!/usr/bin/env bash
#
# usage-diff.sh — compute the per-agent token/run DELTA between the first
# (baseline) and latest snapshot in a usage-snapshot JSONL log, and write a
# plain-text report. Pure jq; spends zero LLM tokens. Pairs with
# usage-snapshot.sh; intended to run on a cron right after the weekly capture.
#
# Usage:
#   scripts/usage-diff.sh [--in LOG] [--out REPORT] [--company ID]
#
# Options (env fallback in parentheses):
#   --in LOG       Snapshot JSONL to read      (PAPERCLIP_SNAPSHOT_OUT, default ./usage-snapshots.jsonl)
#   --out REPORT   File to write (overwrite); if omitted, prints to stdout.
#   --company ID   Only compare records for this company (else the whole log,
#                  which is correct when the log holds a single company).
#   -h, --help     Show this help.
#
# Compares DELTAS (latest minus baseline), never cumulative totals. If fewer than
# two snapshots exist it says so instead of inventing a diff.
#
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

usage() { sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; }

IN="${PAPERCLIP_SNAPSHOT_OUT:-usage-snapshots.jsonl}"
OUT=""
CID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --in) IN="${2:?--in needs a value}"; shift 2 ;;
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    --company) CID="${2:?--company needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "usage-diff: jq is required" >&2; exit 3; }
[ -s "$IN" ] || { echo "usage-diff: log not found or empty: $IN" >&2; exit 4; }

report="$(jq -rs --arg cid "$CID" '
  (map(select(has("error") | not))
   | map(select(($cid == "") or (.companyId == $cid) or (.companyId == null)))
   | sort_by(.ts)) as $recs
  | ($recs | length) as $n
  | if $n < 2 then
      "Only \($n) snapshot(s) in the log — nothing to diff yet" +
      (if $n == 1 then " (baseline \($recs[0].ts)). Re-run after the next capture." else "." end)
    else
      $recs[0] as $b | $recs[-1] as $l
      | (($b.byAgent // []) | map({key: .agentId, value: .}) | from_entries) as $bm
      | (($l.byAgent // [])
         | map(select(.agentStatus != "terminated"))
         | map({ name: .agentName,
                 dr: (.subscriptionRunCount - (($bm[.agentId].subscriptionRunCount) // 0)),
                 dc: (.cachedInputTokens   - (($bm[.agentId].cachedInputTokens)   // 0)),
                 do: (.outputTokens        - (($bm[.agentId].outputTokens)        // 0)) })
         | sort_by(-.dc)) as $rows
      | ($rows | map(.dr) | add) as $tr
      | ["Token-usage delta — compare DELTAS, not cumulative totals",
         "Baseline: \($b.ts)    Latest: \($l.ts)    (\($n) snapshots)",
         ""]
        + ($rows | map(
            "  \(.name[0:26]) | Δruns=\(.dr)  Δcached=\((.dc / 1000000 * 10 | round) / 10)M  Δoutput=\(.do)"))
        + ["",
           "  TOTAL | Δruns=\($tr)  Δcached=\((($rows | map(.dc) | add) / 1000000 * 10 | round) / 10)M  Δoutput=\($rows | map(.do) | add)",
           "",
           (if $tr < 20
            then "Note: little ran this period (Δruns=\($tr)) — treat deltas as noise; re-check next week."
            else "For model attribution (are migrated agents now on Sonnet?), ask Claude to interpret this log + byAgentModel." end)]
      | .[]
    end
' "$IN")" || { echo "usage-diff: jq failed" >&2; exit 5; }

stamp="usage-diff generated $(date -u +%Y-%m-%dT%H:%M:%SZ) from $IN"
if [ -n "$OUT" ]; then
  printf '%s\n%s\n' "$stamp" "$report" > "$OUT"
  echo "usage-diff: report written to $OUT"
else
  printf '%s\n%s\n' "$stamp" "$report"
fi
