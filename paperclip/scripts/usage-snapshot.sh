#!/usr/bin/env bash
#
# usage-snapshot.sh — append a timestamped token-usage snapshot for one or more
# Paperclip companies. Pure curl + jq against the control-plane API; spends zero
# LLM tokens. Intended for periodic capture (e.g. a weekly cron) so per-agent
# token consumption can be compared over time by diffing two records' deltas.
#
# Usage:
#   scripts/usage-snapshot.sh [--base URL] [--company ID]... [--out FILE]
#
# Options (env fallback in parentheses):
#   --base URL     Control-plane base URL      (PAPERCLIP_API_URL, default http://localhost:3100)
#   --company ID   Company id to snapshot; may be repeated.
#                                              (PAPERCLIP_COMPANY_ID) If omitted, ALL companies.
#   --out FILE     JSONL file to append to     (PAPERCLIP_SNAPSHOT_OUT, default ./usage-snapshots.jsonl)
#   -h, --help     Show this help.
#
# Auth: if PAPERCLIP_API_KEY is set, it is sent as a bearer token (needed only on
# deployments that require auth; a local_trusted instance needs none).
#
# Each run appends one JSON line per company:
#   {"ts","companyId","companyName","byAgent":[...],"byAgentModel":[...],"runActivity":[...]}
# Diff two records' byAgent[].cachedInputTokens / .subscriptionRunCount to see the
# delta over the period (compare DELTAS, not the cumulative totals).
#
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

usage() { sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'; }

BASE="${PAPERCLIP_API_URL:-http://localhost:3100}"
OUT="${PAPERCLIP_SNAPSHOT_OUT:-usage-snapshots.jsonl}"
COMPANIES=()
[ -n "${PAPERCLIP_COMPANY_ID:-}" ] && COMPANIES+=("$PAPERCLIP_COMPANY_ID")

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:?--base needs a value}"; shift 2 ;;
    --company) COMPANIES+=("${2:?--company needs a value}"); shift 2 ;;
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "usage-snapshot: curl is required" >&2; exit 3; }
command -v jq   >/dev/null 2>&1 || { echo "usage-snapshot: jq is required" >&2; exit 3; }

AUTH=()
[ -n "${PAPERCLIP_API_KEY:-}" ] && AUTH=(-H "Authorization: Bearer ${PAPERCLIP_API_KEY}")

api() { curl -s --max-time 15 "${AUTH[@]}" "${BASE%/}/api/$1" 2>/dev/null; }

# Resolve the company list: explicit ids, else discover every company.
if [ "${#COMPANIES[@]}" -eq 0 ]; then
  while IFS= read -r id; do [ -n "$id" ] && COMPANIES+=("$id"); done \
    < <(api "companies" | jq -r '.[]?.id // empty' 2>/dev/null)
fi
if [ "${#COMPANIES[@]}" -eq 0 ]; then
  echo "usage-snapshot: no companies found at ${BASE} (is the server up / auth set?)" >&2
  exit 4
fi

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OUT_DIR="$(dirname -- "$OUT")"
[ -n "$OUT_DIR" ] && mkdir -p "$OUT_DIR" 2>/dev/null || true

rc=0
for cid in "${COMPANIES[@]}"; do
  [ -n "$cid" ] || continue
  name="$(api "companies/$cid" | jq -r '(.name // .company.name) // empty' 2>/dev/null)"
  ba="$(api "companies/$cid/costs/by-agent")"
  bam="$(api "companies/$cid/costs/by-agent-model")"
  ra="$(api "companies/$cid/dashboard" | jq -c '.runActivity // []' 2>/dev/null)"
  echo "$ba"  | jq -e . >/dev/null 2>&1 || ba='[]'
  echo "$bam" | jq -e . >/dev/null 2>&1 || bam='[]'
  echo "$ra"  | jq -e . >/dev/null 2>&1 || ra='[]'
  if jq -cn --arg ts "$TS" --arg cid "$cid" --arg name "$name" \
       --argjson ba "$ba" --argjson bam "$bam" --argjson ra "$ra" \
       '{ts:$ts, companyId:$cid, companyName:$name, byAgent:$ba, byAgentModel:$bam, runActivity:$ra}' \
       >> "$OUT" 2>/dev/null; then
    printf 'usage-snapshot: %s%s -> %s @ %s\n' "$cid" "${name:+ ($name)}" "$OUT" "$TS"
  else
    printf '{"ts":"%s","companyId":"%s","error":"snapshot failed"}\n' "$TS" "$cid" >> "$OUT"
    printf 'usage-snapshot: FAILED for %s @ %s\n' "$cid" "$TS" >&2
    rc=1
  fi
done
exit "$rc"
