#!/usr/bin/env bash
# Usage: validate-templates.sh [<kit-root>]
# Checks templates/company/{roster,routines,blueprint}.json and templates/client/*.md against
# the kit's agents/ and skills/ directories. Exit 0 when valid; prints every problem found.
set -uo pipefail
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
[ -d "$ROOT/templates/company" ] || { echo "INVALID: no templates/company under $ROOT" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
C="$ROOT/templates/company"
bad=0
err() { echo "INVALID: $*"; bad=1; }

for f in roster routines blueprint; do
  [ -f "$C/$f.json" ] || { err "missing $C/$f.json"; continue; }
  jq -e . "$C/$f.json" >/dev/null 2>&1 || err "$f.json is not valid JSON"
done
for f in profile-overrides client; do
  [ -f "$ROOT/templates/client/$f.md" ] || err "missing templates/client/$f.md"
done
[ "$bad" = 0 ] || exit 1

R="$C/roster.json"; RT="$C/routines.json"; B="$C/blueprint.json"
jq -e 'type=="array" and length>0' "$R" >/dev/null || { err "roster.json must be a non-empty array"; exit 1; }

n="$(jq length "$R")"
for i in $(seq 0 $((n - 1))); do
  d="$(jq -r ".[$i].dir // empty" "$R")"
  if [ -z "$d" ]; then err "roster entry $i is missing dir"; continue; fi
  for k in name title role tier desiredSkills env timeoutSec maxTurnsPerRun instructionsFile; do
    jq -e ".[$i] | has(\"$k\")" "$R" >/dev/null || err "roster $d is missing $k"
  done
  [ -f "$ROOT/agents/$d/AGENTS.md" ] || err "roster $d has no agents/$d/AGENTS.md"
  tier="$(jq -r ".[$i].tier // empty" "$R")"
  case "$tier" in opus|sonnet) ;; *) err "roster $d has tier \"$tier\" (opus|sonnet)" ;; esac
  role="$(jq -r ".[$i].role // empty" "$R")"
  case "$role" in ceo|cto|cmo|cfo|security|engineer|designer|pm|qa|devops|researcher|general) ;; *) err "roster $d has unknown role \"$role\"" ;; esac
  jq -e ".[$i] | (.timeoutSec|type==\"number\") and (.maxTurnsPerRun|type==\"number\")" "$R" >/dev/null || err "roster $d timeoutSec/maxTurnsPerRun must be numbers"
  jq -e ".[$i] | .reportsTo == null or (.reportsTo|type==\"string\")" "$R" >/dev/null || err "roster $d has a non-string reportsTo"
  jq -e ".[$i].env | type==\"object\"" "$R" >/dev/null 2>&1 || err "roster $d env must be an object"
  f="$(jq -r ".[$i].instructionsFile // empty" "$R")"
  [ -n "$f" ] && [ ! -f "$ROOT/$f" ] && err "roster $d instructionsFile $f does not exist"
  while IFS= read -r s; do
    [ -n "$s" ] && [ ! -f "$ROOT/skills/$s/SKILL.md" ] && err "roster $d desiredSkills entry \"$s\" not found under skills/"
  done < <(jq -r ".[$i].desiredSkills[]?" "$R")
done

dirs="$(jq -r '.[].dir // empty' "$R")"
dup="$(sort <<<"$dirs" | uniq -d)"
[ -z "$dup" ] || err "duplicate roster dir: $dup"
has_dir() { grep -qxF -- "$1" <<<"$dirs"; }

while IFS=$'\t' read -r d r; do
  [ -z "$r" ] || [ "$r" = null ] || has_dir "$r" || err "roster $d reportsTo unknown dir \"$r\""
done < <(jq -r '.[] | select(.dir) | [.dir, (.reportsTo // "null")] | @tsv' "$R")

# routines
jq -e 'type=="array" and length>0' "$RT" >/dev/null || err "routines.json must be a non-empty array"
while IFS=$'\t' read -r t a trig; do
  [ -n "$t" ] || err "a routine has no title"
  has_dir "$a" || err "routine \"$t\" assigneeDir \"$a\" is not in the roster"
  [ "$trig" = manual ] || err "routine \"$t\" trigger must be manual"
done < <(jq -r '.[] | [(.title // ""), (.assigneeDir // ""), (.trigger // "")] | @tsv' "$RT")
jq -e 'all(.[]; (.variables|type=="array") and all(.variables[]; has("name") and (.required|type=="boolean")))' "$RT" >/dev/null || err "every routine variable needs name and boolean required"
jq -e '[.[] | select(.title|startswith("Crew retrospective")) | .variables[] | select(.name=="satisfactionScore")] | length==1 and all(.[]; .required==false)' "$RT" >/dev/null || err "Crew retrospective must declare satisfactionScore with required false"
routine_known() { jq -e --arg n "$1" 'any(.[]; .title == $n or (.title | startswith($n + " —")))' "$RT" >/dev/null; }

# blueprint
[ "$(jq -r .mode "$B")" = standard ] || err "blueprint mode must be standard"
ia="$(jq -r '.intake_agent // empty' "$B")"
has_dir "$ia" || err "blueprint intake_agent \"$ia\" is not in the roster"
jq -e '.gated_subtask_kinds|type=="array" and length>0' "$B" >/dev/null || err "blueprint gated_subtask_kinds must be a non-empty array"
jq -e '.halt_phrases|type=="array" and length>0' "$B" >/dev/null || err "blueprint halt_phrases must be a non-empty array"
for chain in subtask_stages feature_stages; do
  jq -e ".$chain|type==\"array\" and length>0" "$B" >/dev/null || { err "blueprint $chain must be a non-empty array"; continue; }
  while IFS=$'\t' read -r ty pt pd; do
    case "$ty" in review|approval) ;; *) err "$chain stage type \"$ty\" (review|approval)" ;; esac
    case "$pt" in
      agent) has_dir "$pd" || err "$chain stage participant dir \"$pd\" is not in the roster" ;;
      user) ;;
      *) err "$chain participant type \"$pt\" (agent|user)" ;;
    esac
  done < <(jq -r ".$chain[] | .type as \$t | (.participants // [])[] | [\$t, .type, (.dir // \"\")] | @tsv" "$B")
  jq -e ".$chain | all(.[]; (.participants|type==\"array\" and length>0))" "$B" >/dev/null || err "every $chain stage needs participants"
done
jq -e '[.feature_stages[] | select(.type=="approval")] | length==1 and (.[0].participants | all(.[]; .type=="user"))' "$B" >/dev/null || err "feature_stages needs exactly one approval stage with user participants"
jq -e '.feature_stages[-1].type=="approval"' "$B" >/dev/null || err "feature_stages must end with the approval stage"
jq -e '[.subtask_stages[].participants[] | select(.type=="user")] | length==0' "$B" >/dev/null || err "subtask_stages must not have user participants"
rn="$(jq -r '.retro.routineName // empty' "$B")"
if [ -z "$rn" ]; then err "blueprint retro.routineName is missing"; else routine_known "$rn" || err "blueprint retro routine \"$rn\" is not in routines.json"; fi
jq -e '.retro | (.autoTrigger|type=="boolean") and (.bounceThreshold|type=="number") and (.cooldownHours|type=="number")' "$B" >/dev/null || err "blueprint retro needs autoTrigger, bounceThreshold, cooldownHours"
pm="$(jq -r '.prepare_for_merge_routineName // empty' "$B")"
if [ -z "$pm" ]; then err "blueprint prepare_for_merge_routineName is missing"; else routine_known "$pm" || err "blueprint prepare-for-merge routine \"$pm\" is not in routines.json"; fi
for l in kind:impl kind:tests kind:repro security-relevant; do
  jq -e --arg l "$l" 'any(.labels[]?; .name==$l and (.description|length>0))' "$B" >/dev/null || err "blueprint labels is missing \"$l\" with a description"
done

[ "$bad" = 0 ] && echo "templates OK"
exit "$bad"
