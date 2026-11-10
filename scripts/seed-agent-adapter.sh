#!/usr/bin/env bash
# Seeds every agent of a company with the kit's hook settings and per-role env.
# Usage: seed-agent-adapter.sh --api <url> --company <id> --env-file <path>
#
# Env file: KEY=VALUE lines (common to every agent), plus optional sections
# `[role:<dir>]` whose KEY=VALUE lines apply only to that role (e.g. [role:guinan]).
# A role is matched by the agent's roster name (templates/company/roster.json when
# present, as an array of {dir,name}), else by the agent's name slug
# ("Lt. Commander Data" -> data, "Ro Laren" -> ro-laren, "O'Brien" -> obrien).
# Existing adapterConfig fields are kept; extraArgs is set to the settings pair; env is merged
# (values are stored as plain env bindings {type:"plain",value}, the server's own shape).
# PATCHes only when the result differs; prints `updated <name>` or `unchanged <name>`.
set -euo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="" COMPANY="" ENVFILE=""
usage() { echo "Usage: $0 --api <url> --company <id> --env-file <path>" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --api) API="${2:-}"; shift 2 ;;
    --company) COMPANY="${2:-}"; shift 2 ;;
    --env-file) ENVFILE="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$API" ] && [ -n "$COMPANY" ] && [ -n "$ENVFILE" ] || usage
[ -f "$ENVFILE" ] || { echo "env file not found: $ENVFILE" >&2; exit 2; }
API="${API%/}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# Parse the env file into {common:{}, roles:{dir:{}}}.
section=""
printf '{}' > "$TMP/envdoc.json"
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%$'\r'}"
  case "$line" in ''|'#'*) continue ;; esac
  if [[ "$line" =~ ^\[role:([A-Za-z0-9_-]+)\]$ ]]; then section="${BASH_REMATCH[1]}"; continue; fi
  [[ "$line" == *=* ]] || { echo "bad env line: $line" >&2; exit 2; }
  k="${line%%=*}"; v="${line#*=}"
  jq --arg s "$section" --arg k "$k" --arg v "$v" \
    'if $s=="" then .common[$k]=$v else .roles[$s][$k]=$v end' "$TMP/envdoc.json" > "$TMP/envdoc.new"
  mv "$TMP/envdoc.new" "$TMP/envdoc.json"
done < "$ENVFILE"

AGENTS_REPO_VAL="$(jq -r '.common.AGENTS_REPO // empty' "$TMP/envdoc.json")"
AGENTS_REPO_VAL="${AGENTS_REPO_VAL:-$KIT}"
ROSTER="$KIT/templates/company/roster.json"

slug() { printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -d "'" | sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-//' -e 's/-$//'; }
role_of() { # name -> role dir (may be empty)
  local name="$1" r s
  if [ -f "$ROSTER" ]; then
    r="$(jq -r --arg n "$name" '[.[]? | select(.name==$n) | .dir][0] // empty' "$ROSTER" 2>/dev/null || true)"
    [ -n "$r" ] && { echo "$r"; return; }
  fi
  s="$(slug "$name")"
  while IFS= read -r r; do
    if [ "$s" = "$r" ] || [[ "-$s-" == *"-$r-"* ]]; then echo "$r"; return; fi
  done < <(jq -r '.roles // {} | keys[]' "$TMP/envdoc.json")
}

# api <method> <path> <outfile> [data-file]: non-2xx prints status and body, returns 1.
api() {
  local method="$1" path="$2" out="$3" data="${4:-}" code
  local args=(-sS --max-time 30 -X "$method" -o "$out" -w '%{http_code}')
  [ -n "$data" ] && args+=(-H 'content-type: application/json' -d @"$data")
  code="$(curl "${args[@]}" "$API$path")" || { echo "$method $path: request failed" >&2; return 1; }
  case "$code" in
    2??) return 0 ;;
    *) echo "$method $path: HTTP $code: $(head -c 2000 "$out")" >&2; return 1 ;;
  esac
}

api GET "/api/companies/$COMPANY/agents" "$TMP/agents.json" || exit 1
jq -e 'type=="array"' "$TMP/agents.json" >/dev/null 2>&1 \
  || { echo "agent list for $COMPANY is not a JSON array: $(head -c 300 "$TMP/agents.json")" >&2; exit 1; }
[ "$(jq length "$TMP/agents.json")" -gt 0 ] || { echo "company $COMPANY has no agents" >&2; exit 1; }
jq -r '.[] | [.id, .name] | @tsv' "$TMP/agents.json" > "$TMP/agents.tsv" || exit 1

while IFS=$'\t' read -r id name; do
  api GET "/api/agents/$id" "$TMP/agent.json" || exit 1
  role="$(role_of "$name")"
  [ -n "$role" ] || echo "warning: no role section matches agent '$name'; common env only" >&2
  jq --slurpfile e "$TMP/envdoc.json" --arg role "$role" --arg repo "$AGENTS_REPO_VAL" '
    (.adapterConfig // {}) as $cur
    | ($e[0].common // {}) as $common
    | (if $role=="" then {} else ($e[0].roles[$role] // {}) end) as $over
    | $cur
    | .extraArgs = ["--settings", ($repo + "/hooks/claude-settings.json")]
    | .env = (($cur.env // {}) + (($common + $over) | map_values({type: "plain", value: .})))' "$TMP/agent.json" > "$TMP/desired.json" || exit 1
  if [ "$(jq -cS '.adapterConfig // {}' "$TMP/agent.json")" = "$(jq -cS . "$TMP/desired.json")" ]; then
    echo "unchanged $name"
  else
    jq '{adapterConfig: .}' "$TMP/desired.json" > "$TMP/patch.json" || exit 1
    api PATCH "/api/agents/$id" "$TMP/patch.out" "$TMP/patch.json" || { echo "PATCH failed for $name" >&2; exit 1; }
    echo "updated $name"
  fi
done < "$TMP/agents.tsv"
