#!/usr/bin/env bash
# Tests validate-templates.sh against the shipped templates and mutated copies.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$(cd "$DIR/.." && pwd)"
SH="$DIR/validate-templates.sh"
fail=0
check() { if "${@:2}"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# mutate <name> <file> <jq-filter>: copy of the kit (templates copied, agents/skills linked) with one change
mutate() {
  local root="$TMP/$1"
  mkdir -p "$root"
  cp -r "$KIT/templates" "$root/templates"
  ln -s "$KIT/agents" "$root/agents"
  ln -s "$KIT/skills" "$root/skills"
  jq "$3" "$KIT/templates/company/$2" > "$root/templates/company/$2"
  echo "$root"
}

out="$("$SH" 2>&1)"; rc=$?
check "shipped templates pass" test "$rc" = 0

root="$(mutate nodir roster.json 'del(.[0].dir)')"
out="$("$SH" "$root" 2>&1)"; rc=$?
check "roster entry missing dir exits 1" test "$rc" = 1
check "missing dir is reported" grep -qF "dir" <<<"$out"

root="$(mutate badboss roster.json '.[1].reportsTo = "nobody"')"
out="$("$SH" "$root" 2>&1)"; rc=$?
check "unknown reportsTo exits 1" test "$rc" = 1
check "unknown reportsTo is named" grep -qF "nobody" <<<"$out"

root="$(mutate badtier roster.json '.[0].tier = "haiku"')"
out="$("$SH" "$root" 2>&1)"; rc=$?
check "bad tier exits 1" test "$rc" = 1
check "bad tier is named" grep -qF "haiku" <<<"$out"

root="$(mutate badstage blueprint.json '.feature_stages[0].participants[0].dir = "ghost"')"
out="$("$SH" "$root" 2>&1)"; rc=$?
check "stage with unknown dir exits 1" test "$rc" = 1
check "stage unknown dir is named" grep -qF "ghost" <<<"$out"

root="$(mutate badassignee routines.json '.[0].assigneeDir = "ghost"')"
out="$("$SH" "$root" 2>&1)"; rc=$?
check "routine with unknown assigneeDir exits 1" test "$rc" = 1
check "routine unknown assignee is named" grep -qF "ghost" <<<"$out"

root="$(mutate badskill roster.json '.[0].desiredSkills += ["no-such-skill"]')"
out="$("$SH" "$root" 2>&1)"; rc=$?
check "unknown skill exits 1" test "$rc" = 1
check "unknown skill is named" grep -qF "no-such-skill" <<<"$out"

root="$(mutate badinstr roster.json '.[0].instructionsFile = "agents/none/AGENTS.md"')"
out="$("$SH" "$root" 2>&1)"; rc=$?
check "missing instructionsFile exits 1" test "$rc" = 1
check "missing instructionsFile is named" grep -qF "agents/none/AGENTS.md" <<<"$out"

root="$(mutate noagent roster.json '.[0].dir = "phantom" | .[0].instructionsFile = "agents/phantom/AGENTS.md"')"
out="$("$SH" "$root" 2>&1)"; rc=$?
check "dir without AGENTS.md exits 1" test "$rc" = 1
check "dir without AGENTS.md is named" grep -qF "phantom" <<<"$out"

root="$(mutate badretro blueprint.json 'del(.retro.routineName)')"
out="$("$SH" "$root" 2>&1)"; rc=$?
check "retro without routineName exits 1" test "$rc" = 1

root="$(mutate badroutine blueprint.json '.retro.routineName = "Nope"')"
out="$("$SH" "$root" 2>&1)"; rc=$?
check "retro routineName not in routines exits 1" test "$rc" = 1
check "retro routine is named" grep -qF "Nope" <<<"$out"

root="$(mutate badscore routines.json '(.[0].variables[] | select(.name=="satisfactionScore")).required = true')"
out="$("$SH" "$root" 2>&1)"; rc=$?
check "required satisfactionScore exits 1" test "$rc" = 1

root="$(mutate noapproval blueprint.json '.feature_stages |= map(select(.type != "approval"))')"
out="$("$SH" "$root" 2>&1)"; rc=$?
check "feature chain without approval exits 1" test "$rc" = 1

out="$("$SH" "$TMP/does-not-exist" 2>&1)"; rc=$?
check "missing kit root exits 1" test "$rc" = 1
exit "$fail"
