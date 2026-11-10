#!/usr/bin/env bash
# completion-gate.sh: PreToolUse(Bash) gate. Blocks marking a top-level Paperclip
# issue done until visual evidence exists for it, or a WAIVER file has been written.
#
# Environment read:
#   COMPLETION_GATE_EVIDENCE_DIR  evidence root, default $HOME/.paperclip-enterprise/evidence/visual.
#                                 Evidence for issue <id> lives in <root>/<id>/ : an image or
#                                 video file (png jpg jpeg gif webp mp4 webm mov), or a file
#                                 named WAIVER (or WAIVER.txt) holding a one-line reason.
#   PAPERCLIP_API_URL / PAPERCLIP_API_KEY  used to look the issue up; an issue with a parentId
#                                 is a subtask and is exempt. If the lookup cannot be made or
#                                 fails, the gate fails closed (evidence or waiver required).
#
# Scope: every curl / http / wget invocation in the command is evaluated on its own by
# completion_gate_parse.py (next to this file). Gated: a PATCH of /api/issues/<id> whose own
# body sets status "done" (inline, -d/--data/--data-binary/--data-raw/--json @file,
# --data-urlencode @file, -T/--upload-file <file>, httpie items, wget --body-data/-file;
# relative files resolve against the hook input's cwd). Exempt: a PATCH whose own body,
# parsed as JSON, has a top-level "executionDecision" of approve / request_changes / hold
# (a stage participant's verdict; the server answers 422 when there is no active stage).
# A decision string elsewhere in the command or inside a string value never exempts.
# Glued short options (-XPATCH, -sXPATCH, -sd@file) are recognised. An unreadable body
# file, an unparsable command, or no python3 fails closed. Commands that merely mention
# the strings (grep patterns, echo lines) exit 0 with no output.
#
# Contract: exit 0 with no output = no opinion; exit 0 with deny JSON = block.
# No `set -e`: a stray non-zero exit must never fail open.

input="$(cat 2>/dev/null)"
[ -n "$input" ] || exit 0

# A rough look used only when the real parser cannot run (no jq or no python3): fail closed.
looks_like_issue_patch() {
  printf '%s' "$1" | grep -Eq '(curl|http|wget)[[:space:]]' || return 1
  printf '%s' "$1" | grep -Eq -- '-[[:alnum:]]*X[[:space:]]*PATCH|--request[[:space:]=]+PATCH|--method=PATCH|[[:space:]]PATCH[[:space:]]' || return 1
  printf '%s' "$1" | grep -Eq '/api/issues/[^/ ]+'
}
fallback_deny() { # $1 = what is missing
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: this looks like a PATCH of an issue, but %s is not installed so the completion gate cannot check whether it marks the issue done. Install %s and retry."}}\n' "$1" "$1"
  exit 0
}

# Without jq the JSON cannot be parsed: scan the raw input and fail closed.
if ! command -v jq >/dev/null 2>&1; then
  looks_like_issue_patch "$input" && fallback_deny jq
  exit 0
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deny() {
  jq -nc --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)"
[ -n "$cmd" ] || exit 0
cwd="$(printf '%s' "$input" | jq -r '.cwd // .tool_input.cwd // ""' 2>/dev/null)"
case "$cmd" in *curl*|*http*|*wget*) ;; *) exit 0 ;; esac

if ! command -v python3 >/dev/null 2>&1; then
  looks_like_issue_patch "$cmd" && fallback_deny python3
  exit 0
fi
verdicts="$(GATE_CMD="$cmd" GATE_CWD="$cwd" python3 -I "$HERE/completion_gate_parse.py" 2>/dev/null)"; prc=$?
if [ "$prc" -ne 0 ]; then
  looks_like_issue_patch "$cmd" && deny "BLOCKED: the completion gate parser failed on this command, so it cannot check whether it marks an issue done. Simplify the command and retry."
  exit 0
fi
[ -n "$verdicts" ] || exit 0
reason="$(printf '%s\n' "$verdicts" | awk -F'\t' '$1=="DENY"{print substr($0, index($0,"\t")+1); exit}')"
[ -n "$reason" ] && deny "$reason"

check_issue() { # $1 = issue id token from the command; returns, or denies
  local issue_id="$1" resp parent origin record_dir
  # Strip query string, quotes, braces and shell-variable syntax.
  issue_id="${issue_id%%\?*}"
  case "$issue_id" in
    *PAPERCLIP_TASK_ID*) issue_id="${PAPERCLIP_TASK_ID:-$issue_id}" ;;
  esac
  issue_id="$(printf '%s' "$issue_id" | tr -d '"'\''${}\\')"
  [ -n "$issue_id" ] || return 0

  # Subtasks (have a parentId) and routine-execution issues (originKind routine_execution:
  # a routine run has no visual gate) are exempt. Lookup failure falls through (fail closed).
  if [ -n "${PAPERCLIP_API_URL:-}" ] && [ -n "${PAPERCLIP_API_KEY:-}" ]; then
    resp="$(curl -fsS -m 10 -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" \
              "${PAPERCLIP_API_URL%/}/api/issues/${issue_id}" 2>/dev/null)"
    if [ -n "$resp" ]; then
      parent="$(printf '%s' "$resp" | jq -r '(.parentId // .issue.parentId) // empty' 2>/dev/null)"
      [ -n "$parent" ] && return 0
      origin="$(printf '%s' "$resp" | jq -r '(.originKind // .issue.originKind) // empty' 2>/dev/null)"
      [ "$origin" = routine_execution ] && return 0
    fi
  fi

  record_dir="${COMPLETION_GATE_EVIDENCE_DIR:-$HOME/.paperclip-enterprise/evidence/visual}/${issue_id}"
  if [ -d "$record_dir" ]; then
    { [ -f "$record_dir/WAIVER" ] || [ -f "$record_dir/WAIVER.txt" ]; } && return 0
    if find "$record_dir" -type f \
         \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.gif' \
            -o -iname '*.webp' -o -iname '*.mp4' -o -iname '*.webm' -o -iname '*.mov' \) \
         2>/dev/null | grep -q .; then
      return 0
    fi
  fi

  deny "BLOCKED: top-level task ${issue_id} cannot be marked done without visual proof for a human to review. Capture screenshots and/or a screen recording of the feature and save them under ${record_dir}/ , then retry. (Subtasks are exempt; this only gates the top-level task.) If ${issue_id} is not a user-visible feature (research, docs, ops), write a one-line reason to ${record_dir}/WAIVER to waive the check, then retry."
}

while IFS=$'\t' read -r kind id; do
  [ "$kind" = GATE ] && check_issue "$id"
done <<EOF
$verdicts
EOF
exit 0
