#!/usr/bin/env bash
# Tests for completion-gate.sh. Feeds PreToolUse JSON on stdin, asserts exit code and stdout.
# The API lookup is mocked with a stub `curl` placed first on PATH (STUB_MODE: top | sub | routine | manual | fail).
# Fixture strings are built by concatenation so this file never holds an issue API path
# together with the done-status pair on one line.
# Run: bash hooks/test_completion_gate.sh   Exit 0 = all pass.
GATE="${GATE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/completion-gate.sh}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/evidence"
cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
case "${STUB_MODE:-top}" in
  sub) echo '{"id":"x","parentId":"parent-1"}' ;;
  top) echo '{"id":"x","parentId":null}' ;;
  routine) echo '{"id":"x","parentId":null,"originKind":"routine_execution"}' ;;
  manual) echo '{"id":"x","parentId":null,"originKind":"manual"}' ;;
  *) exit 22 ;;
esac
STUB
chmod +x "$TMP/bin/curl"

API="/api/"; API="${API}issues/"
DONE_KEY='"status"'; DONE_VAL='"done"'; DONE="${DONE_KEY}:${DONE_VAL}"
BODY="{${DONE}}"
fails=0; total=0

run() { # name mode expect(deny|none) command [cwd]
  local name="$1" mode="$2" expect="$3" cmd="$4" cwd="${5:-}" out rc
  total=$((total+1))
  out="$(jq -nc --arg c "$cmd" --arg d "$cwd" '{tool_input:{command:$c}} + (if $d == "" then {} else {cwd:$d} end)' | PATH="$TMP/bin:$PATH" STUB_MODE="$mode" \
    PAPERCLIP_API_URL=http://localhost:3100 PAPERCLIP_API_KEY=k \
    COMPLETION_GATE_EVIDENCE_DIR="$TMP/evidence" bash "$GATE")"; rc=$?
  local ok=1
  [ "$rc" -eq 0 ] || ok=0
  case "$expect" in
    deny) printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || ok=0 ;;
    none) [ -z "$out" ] || ok=0 ;;
  esac
  if [ "$ok" -eq 1 ]; then echo "[PASS] $name"; else echo "[FAIL] $name: rc=$rc out=$out"; fails=$((fails+1)); fi
}

PATCH_CMD="curl -s -X PATCH http://localhost:3100${API}ISSUE-1 -H 'Content-Type: application/json' -d '${BODY}'"
SUB_CMD="curl -s -X PATCH http://localhost:3100${API}ISSUE-2 -d '${BODY}'"

run "top-level completion without evidence is denied" top deny "$PATCH_CMD"
run "long-form --request is gated too" top deny "curl --request PATCH http://localhost:3100${API}ISSUE-1 -d '${BODY}'"
run "lookup failure fails closed" fail deny "$PATCH_CMD"
mkdir -p "$TMP/evidence/ISSUE-1"; : > "$TMP/evidence/ISSUE-1/WAIVER"
run "WAIVER allows the completion" top none "$PATCH_CMD"
rm "$TMP/evidence/ISSUE-1/WAIVER"; : > "$TMP/evidence/ISSUE-1/shot.png"
run "image evidence allows the completion" top none "$PATCH_CMD"
run "subtask completion is allowed without evidence" sub none "$SUB_CMD"
run "routine-execution issue completion is allowed without evidence" routine none "curl -s -X PATCH http://localhost:3100${API}ISSUE-R -d '${BODY}'"
run "a top-level issue of another origin is still gated" manual deny "curl -s -X PATCH http://localhost:3100${API}ISSUE-R -d '${BODY}'"
run "non-completion command produces no output" top none "ls -la && git status"
run "other status patch is not gated" top none "curl -X PATCH http://localhost:3100${API}ISSUE-3 -d '{\"status\":\"in_progress\"}'"
run "GET of an issue is not gated" top none "curl http://localhost:3100${API}ISSUE-3"
# Review Focus 3: command text that merely mentions the path and the pair.
run "grep for the pair piped into grep for the path is allowed" top none "grep '${DONE}' notes.txt | grep '${API}ISSUE-4'"
run "echo of a line with path and pair redirected to a log is allowed" top none "echo \"PATCH ${API}ISSUE-4 ${BODY}\" >> run.log"

# I4: WAIVER.txt is honoured, and a lookup failure with evidence present still passes.
mkdir -p "$TMP/evidence/ISSUE-5"; : > "$TMP/evidence/ISSUE-5/WAIVER.txt"
run "WAIVER.txt allows the completion" top none "curl -X PATCH http://localhost:3100${API}ISSUE-5 -d '${BODY}'"
run "lookup failure with evidence present allows" fail none "$PATCH_CMD"
run "lookup failure with no evidence for another issue denies" fail deny "curl -X PATCH http://localhost:3100${API}ISSUE-6 -d '${BODY}'"

# F1: a stage participant's verdict is never gated; @file bodies and glued options are.
DEC_KEY='"executionDecision"'
APPROVE_BODY="{${DEC_KEY}:\"approve\",\"comment\":\"LGTM\"}"
APPROVE_DONE_BODY="{${DONE},${DEC_KEY}:\"approve\",\"comment\":\"LGTM\"}"
run "stage approve with executionDecision on a top-level issue is allowed" top none "curl -s -X PATCH http://localhost:3100${API}ISSUE-7 -d '${APPROVE_BODY}'"
run "stage approve carrying a done status too is still not gated" top none "curl -s -X PATCH http://localhost:3100${API}ISSUE-7 -d '${APPROVE_DONE_BODY}'"
run "plain status-done PATCH inline is denied without evidence" top deny "curl -s -X PATCH http://localhost:3100${API}ISSUE-7 -d '${BODY}'"
mkdir -p "$TMP/work"; printf '%s' "${BODY}" > "$TMP/work/body.json"
run "status-done body via -d @file is denied without evidence" top deny "curl -s -X PATCH http://localhost:3100${API}ISSUE-8 -d @body.json" "$TMP/work"
run "status-done body via --data-binary @file (absolute) is denied" top deny "curl -s -X PATCH http://localhost:3100${API}ISSUE-8 --data-binary @$TMP/work/body.json"
mkdir -p "$TMP/evidence/ISSUE-8"; : > "$TMP/evidence/ISSUE-8/WAIVER"
run "status-done body via -d @file is allowed with WAIVER" top none "curl -s -X PATCH http://localhost:3100${API}ISSUE-8 -d @body.json" "$TMP/work"
run "unreadable @file body is denied" top deny "curl -s -X PATCH http://localhost:3100${API}ISSUE-9 --data @missing.json" "$TMP/work"
printf '%s' "${APPROVE_DONE_BODY}" > "$TMP/work/approve.json"
run "executionDecision body via @file is allowed" top none "curl -s -X PATCH http://localhost:3100${API}ISSUE-9 -d @approve.json" "$TMP/work"
printf '%s' '{"status":"in_progress"}' > "$TMP/work/other.json"
run "non-done body via @file is not gated" top none "curl -s -X PATCH http://localhost:3100${API}ISSUE-9 -d @other.json" "$TMP/work"
run "glued -sXPATCH form is gated" top deny "curl -sXPATCH http://localhost:3100${API}ISSUE-9 -d '${BODY}'"
run "glued -XPATCH form is gated" top deny "curl -XPATCH http://localhost:3100${API}ISSUE-9 -d '${BODY}'"

# Re-review: only a parsed stage decision in that invocation's own body exempts it.
DEC_STR='"executionDecision":1'
run "decision string in another command does not exempt the PATCH" top deny "echo '${DEC_STR}'; curl -s -X PATCH http://localhost:3100${API}ISSUE-10 -d '${BODY}'"
COMMENT_BODY="{${DONE},\"comment\":\"see ${DEC_KEY}: approve\"}"
run "decision string inside the comment text does not exempt" top deny "curl -s -X PATCH http://localhost:3100${API}ISSUE-10 -d '${COMMENT_BODY}'"
BOGUS_BODY="{${DONE},${DEC_KEY}:\"ship-it\"}"
run "executionDecision with an unknown verb does not exempt" top deny "curl -s -X PATCH http://localhost:3100${API}ISSUE-10 -d '${BOGUS_BODY}'"
NESTED_BODY="{${DONE},\"meta\":{${DEC_KEY}:\"approve\"}}"
run "a nested executionDecision does not exempt" top deny "curl -s -X PATCH http://localhost:3100${API}ISSUE-10 -d '${NESTED_BODY}'"
run "an approve on one issue does not exempt a done on another in the same command" top deny "curl -s -X PATCH http://localhost:3100${API}ISSUE-7 -d '${APPROVE_BODY}' && curl -s -X PATCH http://localhost:3100${API}ISSUE-10 -d '${BODY}'"
run "a comment PATCH on the comments path is not gated" top none "curl -s -X PATCH http://localhost:3100${API}ISSUE-10/comments/c1 -d '${BODY}'"
run "an unresolvable body variable is gated" top deny "curl -s -X PATCH http://localhost:3100${API}ISSUE-10 -d \"\$BODY\""
printf '%s' "${BODY}" > "$TMP/work/done.json"
run "--json @file body is gated" top deny "curl -s -X PATCH http://localhost:3100${API}ISSUE-11 --json @done.json" "$TMP/work"
run "done inside sh -c is gated" top deny "sh -c 'curl -s -X PATCH http://localhost:3100${API}ISSUE-11 -d @done.json'" "$TMP/work"
run "-T file body is gated" top deny "curl -s -X PATCH http://localhost:3100${API}ISSUE-11 -T done.json" "$TMP/work"
run "--upload-file file body is gated" top deny "curl -s -X PATCH http://localhost:3100${API}ISSUE-11 --upload-file done.json" "$TMP/work"
run "--data-urlencode @file body is gated" top deny "curl -s -X PATCH http://localhost:3100${API}ISSUE-11 --data-urlencode @done.json" "$TMP/work"
run "--data-urlencode name@file body is gated" top deny "curl -s -X PATCH http://localhost:3100${API}ISSUE-11 --data-urlencode body@done.json" "$TMP/work"
run "-T of an unreadable file is denied" top deny "curl -s -X PATCH http://localhost:3100${API}ISSUE-11 -T nope.json" "$TMP/work"
run "--json @file with a stage decision is allowed" top none "curl -s -X PATCH http://localhost:3100${API}ISSUE-11 --json @approve.json" "$TMP/work"
run "glued -sd@file is gated" top deny "curl -sXPATCH http://localhost:3100${API}ISSUE-11 -sd@done.json" "$TMP/work"
run "httpie status=done is gated" top deny "http PATCH http://localhost:3100${API}ISSUE-12 status=done"
run "httpie stage decision is allowed" top none "http PATCH http://localhost:3100${API}ISSUE-12 executionDecision=approve comment=ok"
run "wget --body-data done is gated" top deny "wget --method=PATCH --body-data='${BODY}' http://localhost:3100${API}ISSUE-12"

# I8: jq missing must not fail open for a completion-looking command; garbage stays silent.
mkdir -p "$TMP/nojq"
for t in grep sed tr head cat find printf; do ln -s "$(command -v $t)" "$TMP/nojq/$t"; done
BASH_BIN="$(command -v bash)"
payload="$(jq -nc --arg c "$PATCH_CMD" '{tool_input:{command:$c}}')"
total=$((total+1))
out="$(printf '%s' "$payload" | PATH="$TMP/nojq" "$BASH_BIN" "$GATE")"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '"permissionDecision":"deny"' && printf '%s' "$out" | grep -q 'jq'; then
  echo "[PASS] jq missing: completion-looking command is denied with a message"
else echo "[FAIL] jq missing deny: rc=$rc out=$out"; fails=$((fails+1)); fi
total=$((total+1))
payload="$(jq -nc --arg c "ls -la" '{tool_input:{command:$c}}')"
out="$(printf '%s' "$payload" | PATH="$TMP/nojq" "$BASH_BIN" "$GATE")"; rc=$?
if [ "$rc" -eq 0 ] && [ -z "$out" ]; then echo "[PASS] jq missing: ordinary command stays silent"
else echo "[FAIL] jq missing ordinary: rc=$rc out=$out"; fails=$((fails+1)); fi
total=$((total+1))
out="$(printf '' | "$BASH_BIN" "$GATE")"; rc=$?
if [ "$rc" -eq 0 ] && [ -z "$out" ]; then echo "[PASS] empty input stays silent"; else echo "[FAIL] empty input"; fails=$((fails+1)); fi
total=$((total+1))
out="$(printf 'not json {' | "$BASH_BIN" "$GATE")"; rc=$?
if [ "$rc" -eq 0 ] && [ -z "$out" ]; then echo "[PASS] unparsable input stays silent"; else echo "[FAIL] unparsable input: $out"; fails=$((fails+1)); fi

echo; echo "$((total-fails))/$total passed"
[ "$fails" -eq 0 ]
