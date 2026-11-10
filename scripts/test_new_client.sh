#!/usr/bin/env bash
# Tests scripts/new-client end to end against a throwaway test instance (3201) and bare
# repositories in a temp code root. A stub `claude` stands in for the real CLI (the login
# probe answers ok; the hook probe runs the kit's real git-guard). Never touches the kit
# instance (3200), ~/.claude or the default code root.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$(cd "$DIR/.." && pwd)"
SH="$DIR/paperclip-instance.sh"
NC="$DIR/new-client"
INST=paperclip-enterprise-test
ARGS=(--instance "$INST" --port 3201 --db-port 54331)
API=http://127.0.0.1:3201
INST_DIR="$HOME/.paperclip/instances/$INST"
TMP="$(mktemp -d)"
CODE="$TMP/code"
fail=0
check() { if "${@:2}"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }
eq() { [ "$1" = "$2" ] || { echo "  expected [$2] got [$1]" >&2; return 1; }; }

cleanup() {
  [ "$fail" = 0 ] || { echo "--- instance log tail ---"; tail -n 60 "$INST_DIR/logs/kit.log" 2>/dev/null | cut -c1-400; }
  "$SH" stop "${ARGS[@]}" >/dev/null 2>&1
  rm -rf "$INST_DIR"
  local wt
  for wt in "$CODE/paperclip-enterprise-fleet"; do
    [ -e "$wt" ] && git -C "$KIT" worktree remove --force "$wt" >/dev/null 2>&1
  done
  git -C "$KIT" worktree prune
  rm -rf "$KIT/clients/zz-test" "$KIT/clients/zz-new" "$KIT/clients/zz-dry" "$KIT/clients/zz-main" "$TMP"
}
trap cleanup EXIT

[ -x "$NC" ] || { echo "FAIL: scripts/new-client missing or not executable"; exit 1; }

# --- stub claude, fake login, isolated evidence dirs -----------------------------------
mkdir -p "$TMP/bin" "$TMP/claude-config" "$CODE"
cat > "$TMP/bin/claude" <<'STUB'
#!/usr/bin/env bash
# Test double for the claude CLI.
prompt=""
while [ $# -gt 0 ]; do [ "$1" = -p ] && { prompt="${2:-}"; shift; }; shift; done
case "$prompt" in
  "reply with ok") echo ok; exit 0 ;;
  "Run exactly: "*)
    cmd="${prompt#Run exactly: }"
    jq -n --arg c "$cmd" --arg d "$PWD" '{tool_name:"Bash",tool_input:{command:$c},cwd:$d}' \
      | python3 "$AGENTS_REPO/hooks/git-guard.py" 2>&1
    exit 0 ;;
esac
# Anything else is a server-side agent run: read the prompt it pipes in (so the server never
# writes into a closed pipe), then fail like a CLI without a usable login.
cat >/dev/null 2>&1
exit 1
STUB
chmod +x "$TMP/bin/claude"
echo '{"claudeAiOauth":{"accessToken":"fake"}}' > "$TMP/claude-config/.credentials.json"
export PATH="$TMP/bin:$PATH"
export CLAUDE_CONFIG_DIR="$TMP/claude-config"
export COMPLETION_GATE_EVIDENCE_DIR="$TMP/evidence/visual" QA_EVIDENCE_DIR="$TMP/evidence/qa"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

# --- a fresh test instance --------------------------------------------------------------
"$SH" stop "${ARGS[@]}" >/dev/null 2>&1
rm -rf "$INST_DIR"
"$SH" start "${ARGS[@]}" || { echo "FAIL: instance start"; exit 1; }

# --- remotes: one with a mainline, one empty ----------------------------------------------
git init -q --bare -b master "$TMP/remote.git"
git init -q -b master "$TMP/seed"
echo "# app" > "$TMP/seed/README.md"
git -C "$TMP/seed" add README.md && git -C "$TMP/seed" commit -qm init
git -C "$TMP/seed" push -q "$TMP/remote.git" master
git init -q --bare -b master "$TMP/empty.git"
git init -q --bare -b main "$TMP/main.git"
git -C "$TMP/seed" push -q "$TMP/main.git" master:main

run() { "$NC" --code-root "$CODE" --instance "$INST" "$@"; }

# --- first run ---------------------------------------------------------------------------
out1="$(run --name zz-test --repo "$TMP/remote.git" 2>&1)"; rc1=$?
echo "$out1" | sed 's/^/  | /'
check "first run exits 0" eq "$rc1" 0
check "first run reports created" grep -q '^created ' <<<"$out1"

companies="$(curl -sf "$API/api/companies")"
check "one company named zz-test" eq "$(jq '[.[]|select(.name=="zz-test")]|length' <<<"$companies")" 1
CID="$(jq -r '[.[]|select(.name=="zz-test")][0].id' <<<"$companies")"
agents="$(curl -sf "$API/api/companies/$CID/agents")"
check "eleven agents" eq "$(jq length <<<"$agents")" 11
check "agent names match the roster" eq "$(jq -c '[.[].name]|sort' <<<"$agents")" "$(jq -c '[.[].name]|sort' "$KIT/templates/company/roster.json")"

models="$(curl -sf "$API/api/companies/$CID/adapters/claude_local/models" | jq -r '.[].id')"
OPUS="$(grep opus <<<"$models" | sort -V | tail -n1)"
SONNET="$(grep sonnet <<<"$models" | sort -V | tail -n1)"
BOARD="$(curl -sf "$API/api/auth/get-session" | jq -r .session.userId)"
OP="$CODE/zz-test"; FL="$CODE/zz-test-fleet"; RT="$CODE/zz-test-retro"
id_of() { jq -r --arg n "$1" '.[]|select(.name==$n)|.id' <<<"$agents"; }

bad_agents=""
while IFS=$'\t' read -r dir name tier reports; do
  a="$(curl -sf "$API/api/agents/$(id_of "$name")")"
  ac="$(jq -c .adapterConfig <<<"$a")"
  want_cwd="$FL"; [ "$dir" = guinan ] && want_cwd="$RT"
  want_model="$OPUS"; [ "$tier" = sonnet ] && want_model="$SONNET"
  ok=1
  [ "$(jq -r .adapterType <<<"$a")" = claude_local ] || ok=0
  [ "$(jq -r .cwd <<<"$ac")" = "$want_cwd" ] || ok=0
  [ "$(jq -r .model <<<"$ac")" = "$want_model" ] || ok=0
  [ "$(jq -r .instructionsFilePath <<<"$ac")" = "$KIT/agents/$dir/AGENTS.md" ] || ok=0
  [ "$(jq -r .instructionsBundleMode <<<"$ac")" = external ] || ok=0
  [ "$(jq -c .extraArgs <<<"$ac")" = "$(jq -nc --arg k "$KIT" '["--settings",($k+"/hooks/claude-settings.json")]')" ] || ok=0
  ev() { jq -r --arg k "$1" '.env[$k].value // "missing"' <<<"$ac"; }
  [ "$(ev CLAUDE_CONFIG_DIR)" = "$TMP/claude-config" ] || ok=0
  [ "$(ev AGENTS_REPO)" = "$KIT" ] || ok=0
  [ "$(ev PRODUCT_OPERATOR_TREE)" = "$OP:$KIT" ] || ok=0
  [ "$(ev PRODUCT_FLEET_TREE)" = "$FL" ] || ok=0
  [ "$(ev PRODUCT_RETRO_TREE)" = "$RT" ] || ok=0
  [ "$(ev PAPERCLIP_BOARD_USER_ID)" = "$BOARD" ] || ok=0
  [ "$(ev GIT_GUARD_MAINLINE)" = master ] || ok=0
  [ "$(ev COMPLETION_GATE_EVIDENCE_DIR)" = "$TMP/evidence/visual" ] || ok=0
  [ "$(ev QA_EVIDENCE_DIR)" = "$TMP/evidence/qa" ] || ok=0
  case "$dir" in
    guinan) [ "$(ev GIT_GUARD_PUSH_ALLOW)" = 'retro/*' ] || ok=0 ;;
    boothby) [ "$(ev GIT_GUARD_PUSH_ALLOW)" = 'onboarding/*' ] || ok=0 ;;
    *) [ "$(ev GIT_GUARD_PUSH_ALLOW)" = missing ] || ok=0 ;;
  esac
  if [ "$dir" = obrien ]; then [ "$(ev GIT_GUARD_FORCE_PUSH_ALLOW)" = 1 ] || ok=0
  else [ "$(ev GIT_GUARD_FORCE_PUSH_ALLOW)" = missing ] || ok=0; fi
  want_to=null; [ "$reports" != null ] && want_to="$(id_of "$(jq -r --arg d "$reports" '.[]|select(.dir==$d)|.name' "$KIT/templates/company/roster.json")")"
  [ "$(jq -r '.reportsTo // "null"' <<<"$a")" = "$want_to" ] || ok=0
  [ "$ok" = 1 ] || bad_agents="$bad_agents $dir"
done < <(jq -r '.[]|[.dir,.name,.tier,(.reportsTo // "null")]|@tsv' "$KIT/templates/company/roster.json")
check "every agent: cwd, instructions, extraArgs, env, model by tier, reportsTo" eq "${bad_agents:-none}" none
check "opus and sonnet models resolved" test -n "$OPUS" -a -n "$SONNET"

bp="$(curl -sf "$API/api/companies/$CID/workflow/blueprint")"
check "five feature stages" eq "$(jq '.featureStages|length' <<<"$bp")" 5
check "feature chain ends in a user approval" eq "$(jq -c '.featureStages[-1]|[.type,.participants[0].type,.participants[0].userId]' <<<"$bp")" "$(jq -nc --arg u "$BOARD" '["approval","user",$u]')"
check "one subtask stage (Hops)" eq "$(jq -r '.subtaskStages|length' <<<"$bp"):$(jq -r '.subtaskStages[0].participants[0].agentId' <<<"$bp")" "1:$(id_of 'Hops the Code Reviewer Rabbit')"
check "intake agent is Data" eq "$(jq -r .intakeAgentId <<<"$bp")" "$(id_of 'Lt. Commander Data')"
check "gated subtask kinds" eq "$(jq -c .gatedSubtaskKinds <<<"$bp")" '["impl","tests"]'
routines="$(curl -sf "$API/api/companies/$CID/routines")"
check "four routines" eq "$(jq length <<<"$routines")" 4
rid() { jq -r --arg p "$1" '[.[]|select(.title|startswith($p))][0].id' <<<"$routines"; }
check "retro routine id" eq "$(jq -r .retro.routineId <<<"$bp")" "$(rid 'Crew retrospective')"
check "retro settings" eq "$(jq -c '[.retro.autoTrigger,.retro.bounceThreshold,.retro.cooldownHours]' <<<"$bp")" '[true,2,24]'
check "prepare-for-merge routine id" eq "$(jq -r .prepareForMergeRoutineId <<<"$bp")" "$(rid 'Prepare branch for merge')"
check "retro routine satisfactionScore not required" eq "$(jq -r '[.[]|select(.title|startswith("Crew retrospective"))][0].variables[]|select(.name=="satisfactionScore")|.required' <<<"$routines")" false
labels="$(curl -sf "$API/api/companies/$CID/labels")"
check "four labels" eq "$(jq -c '[.[].name]|sort' <<<"$labels")" '["kind:impl","kind:repro","kind:tests","security-relevant"]'
projects="$(curl -sf "$API/api/companies/$CID/projects")"
check "one project zz-test" eq "$(jq '[.[]|select(.name=="zz-test")]|length' <<<"$projects")" 1

check "operator tree is a clone on master" eq "$(git -C "$OP" symbolic-ref --short HEAD 2>/dev/null)" master
check "fleet is a worktree of the operator tree" grep -qx "worktree $FL" < <(git -C "$OP" worktree list --porcelain)
check "retro is a worktree of the operator tree" grep -qx "worktree $RT" < <(git -C "$OP" worktree list --porcelain)
check "fleet is not on the mainline" bash -c "[ \"\$(git -C '$FL' symbolic-ref --short HEAD 2>/dev/null)\" != master ]"
check "retro is detached" bash -c "! git -C '$RT' symbolic-ref -q HEAD"
check "kit fleet worktree exists" grep -qx "worktree $CODE/paperclip-enterprise-fleet" < <(git -C "$KIT" worktree list --porcelain)
check "onboarding branch on the remote" git -C "$TMP/remote.git" show-ref -q --verify refs/heads/onboarding/zz-test
check "onboarding branch carries profile.md" bash -c "git -C '$TMP/remote.git' show onboarding/zz-test:.paperclip-enterprise/profile.md | grep -q '^## Branching'"
git -C "$TMP/remote.git" show onboarding/zz-test:.paperclip-enterprise/profile.md > "$TMP/onb-profile.md" 2>/dev/null
check "onboarding profile.md validates" "$DIR/validate-profile.sh" "$TMP/onb-profile.md"
check "onboarding branch carries client.md" git -C "$TMP/remote.git" cat-file -e onboarding/zz-test:.paperclip-enterprise/client.md
check "client.yaml written" grep -q "^company_id: \"$CID\"" "$KIT/clients/zz-test/client.yaml"
check "env file guards the kit checkout as an operator tree" grep -qx "PRODUCT_OPERATOR_TREE=$OP:$KIT" "$KIT/clients/zz-test/agent-env"

issues="$(curl -sf "$API/api/companies/$CID/issues")"
BOOTHBY="$(id_of Boothby)"
# The stub cannot run Boothby, so the server's run recovery may move the issue to a recovery
# owner; the first owner is then the recovery activity's previousOwnerAgentId.
first_owner() { # issue id
  local cur prev
  cur="$(curl -sf "$API/api/issues/$1" | jq -r '.assigneeAgentId // empty')"
  prev="$(curl -sf "$API/api/issues/$1/activity" | jq -r '[.[]? | .details.previousOwnerAgentId // empty] | last // empty')"
  echo "${prev:-$cur}"
}
onb() { jq -r '[.[]|select(.title=="Onboard zz-test")]' <<<"$1"; }
check "one onboarding issue" eq "$(onb "$issues" | jq length)" 1
IID="$(onb "$issues" | jq -r '.[0].id')"
check "onboarding issue assigned to Boothby" eq "$(first_owner "$IID")" "$BOOTHBY"
check "onboarding issue has no execution policy" eq "$(onb "$issues" | jq -r '.[0].executionPolicy')" null
check "summary prints the Paperclip URL" grep -q "$API/" <<<"$out1"

# --- second run: nothing created ----------------------------------------------------------
out2="$(run --name zz-test --repo "$TMP/remote.git" 2>&1)"; rc2=$?
check "second run exits 0" eq "$rc2" 0
check "second run prints no created" bash -c "! grep -q 'created' <<<\"\$1\"" _ "$out2"
grep 'created' <<<"$out2" | sed 's/^/  second run: /'
check "second run reports exists" grep -q '^exists company' <<<"$out2"
check "still one company" eq "$(curl -sf "$API/api/companies" | jq '[.[]|select(.name=="zz-test")]|length')" 1
check "still eleven agents" eq "$(curl -sf "$API/api/companies/$CID/agents" | jq length)" 11
check "still four routines" eq "$(curl -sf "$API/api/companies/$CID/routines" | jq length)" 4
check "still four labels" eq "$(curl -sf "$API/api/companies/$CID/labels" | jq length)" 4
check "still one project" eq "$(curl -sf "$API/api/companies/$CID/projects" | jq length)" 1
check "still one onboarding issue" eq "$(onb "$(curl -sf "$API/api/companies/$CID/issues")" | jq length)" 1

# --- dry run on a new name: no change -----------------------------------------------------
out3="$(run --name zz-dry --repo "$TMP/remote.git" --dry-run 2>&1)"; rc3=$?
check "dry run exits 0" eq "$rc3" 0
check "dry run prints numbered steps" grep -qE '^ ?[0-9]+\. ' <<<"$out3"
check "dry run creates no company" eq "$(curl -sf "$API/api/companies" | jq '[.[]|select(.name=="zz-dry")]|length')" 0
check "dry run clones nothing" test ! -e "$CODE/zz-dry" -a ! -e "$CODE/zz-dry-fleet"
check "dry run writes no client.yaml" test ! -e "$KIT/clients/zz-dry"

# --- a remote whose HEAD is main: the mainline is resolved from it ------------------------
out6="$(run --name zz-main --repo "$TMP/main.git" --dry-run 2>&1)"; rc6=$?
check "main remote: dry run exits 0" eq "$rc6" 0
check "main remote: mainline resolved from the remote HEAD" grep -q 'mainline main,' <<<"$out6"
out7="$(run --name zz-main --repo "$TMP/main.git" --mainline develop 2>&1)"; rc7=$?
check "a missing --mainline branch fails" test "$rc7" -ne 0
check "the error names --mainline" grep -q -- '--mainline' <<<"$out7"

# --- --new on an empty remote: the mainline is initialized --------------------------------
out4="$(run --name zz-new --repo "$TMP/empty.git" --new 2>&1)"; rc4=$?
[ "$rc4" = 0 ] || echo "$out4" | sed 's/^/  | /'
check "--new run exits 0" eq "$rc4" 0
check "--new pushed an initial mainline commit" eq "$(git -C "$TMP/empty.git" log -1 --format=%s master 2>/dev/null)" "chore: initialize repository"
check "--new onboarding branch pushed" git -C "$TMP/empty.git" cat-file -e onboarding/zz-new:.paperclip-enterprise/profile.md
out5="$(run --name zz-new --repo "$TMP/empty.git" --new 2>&1)"; rc5=$?
[ "$rc5" = 0 ] || echo "$out5" | sed 's/^/  | /'
check "--new second run exits 0 and creates nothing" bash -c "[ $rc5 = 0 ] && ! grep -q created <<<\"\$1\"" _ "$out5"

# --- carried helper: the zz-new fleet worktree becomes an independent clone ---------------
NFL="$CODE/zz-new-fleet"
check "fleet-worktree-to-clone dry run" env DRY_RUN=1 "$DIR/fleet-worktree-to-clone.sh" "$CODE/zz-new" "$NFL"
"$DIR/fleet-worktree-to-clone.sh" "$CODE/zz-new" "$NFL" fleet "$TMP/fleet-backup" >/dev/null 2>&1
check "fleet tree is now a standalone clone" test -d "$NFL/.git"
check "operator tree no longer lists the fleet worktree" bash -c "! git -C '$CODE/zz-new' worktree list --porcelain | grep -qx 'worktree $NFL'"

exit $fail
