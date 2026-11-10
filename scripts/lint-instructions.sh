#!/usr/bin/env bash
# Instruction linter: the kit's scrub gate.
# Usage: scripts/lint-instructions.sh [paths...]   (no paths: every file git would commit)
# Exit 0 when clean; exit 1 with one "path:line: rule: text" line per hit; exit 2 when it
# cannot run. The banned lists (banned-terms.txt, banned-patterns.txt) are read from
# $LINT_BANNED_TERMS_DIR, default $HOME/.paperclip-enterprise/lint; the kit ships none.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The banned-term lists are private to the operator and never shipped in the kit.
LINT_BANNED_TERMS_DIR="${LINT_BANNED_TERMS_DIR:-$HOME/.paperclip-enterprise/lint}"
BANNED="$LINT_BANNED_TERMS_DIR/banned-terms.txt"
PATTERNS="$LINT_BANNED_TERMS_DIR/banned-patterns.txt"
if [ ! -d "$LINT_BANNED_TERMS_DIR" ] || [ ! -f "$BANNED" ] || [ ! -f "$PATTERNS" ]; then
  echo "banned-term lists not installed: copy them to $LINT_BANNED_TERMS_DIR (see README)" >&2
  exit 2
fi
cd "$ROOT" || exit 2

# Fail closed: an unreadable or empty terms/patterns file means no banned check, so refuse to run.
TERMS="$(mktemp)" || exit 2
TERMS_PC="$(mktemp)" || exit 2
PATS="$(mktemp)" || exit 2
trap 'rm -f "$TERMS" "$TERMS_PC" "$PATS"' EXIT
prep() { # file out: strip CR and blank lines; exit 2 if unreadable or empty
  if [ ! -r "$1" ]; then
    echo "lint-instructions.sh: cannot read banned file: $1" >&2
    exit 2
  fi
  tr -d '\r' < "$1" | grep -v '^[[:space:]]*$' > "$2"
  if [ ! -s "$2" ]; then
    echo "lint-instructions.sh: banned file has no entries: $1" >&2
    exit 2
  fi
}
prep "$BANNED" "$TERMS"
prep "$PATTERNS" "$PATS"
# local-board is Paperclip's own local_trusted actor id: allowed under paperclip/.
grep -v -i -x -F 'local-board' "$TERMS" > "$TERMS_PC"
[ -s "$TERMS_PC" ] || : > "$TERMS_PC"

hits=0
scan() { # file rule grep-args...; grep status 2 (error) aborts, 1 means no hits
  local f="$1" rule="$2" out rc
  shift 2
  out="$(grep "$@" "$f" 2>&1)"; rc=$?
  # A file that vanished after the scan listed it (a running instance's runtime state) is skipped.
  [ $rc -ge 2 ] && [ ! -e "$f" ] && return 0
  if [ $rc -ge 2 ]; then
    echo "lint-instructions.sh: grep failed on $f: $out" >&2
    exit 2
  fi
  report "$f" "$rule" <<< "$out"
}
report() { # file rule  (stdin: "line:text" pairs)
  local f="$1" rule="$2" n
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    printf '%s:%s: %s: %s\n' "$f" "${l%%:*}" "$rule" "${l#*:}"
    hits=1
  done
}

rule_routing() {
  scan "$1" routing -nIiE 'reassign to|@-mention|agent://|route .* to the operator|PATCH .*assigneeAgentId'
}
rule_uuid() {
  scan "$1" uuid -nIiE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
}
rule_carveout() {
  scan "$1" carveout -nIiE 'Non-blocking findings|Under a native gate|do NOT bounce|never bounce|for the operator to (act on|handle) at merge'
  # "non-blocking" with "approve" on any line within 3 lines before or after
  report "$1" carveout < <(awk '
    { orig[NR] = $0; low[NR] = tolower($0) }
    END {
      for (i = 1; i <= NR; i++) if (index(low[i], "non-blocking"))
        for (j = i - 3; j <= i + 3; j++)
          if (j >= 1 && j <= NR && index(low[j], "approve")) { print i ":" orig[i]; break }
    }' "$1")
}
rule_board_literal() {
  scan "$1" board-literal -nIiF 'local-board'
}
rule_abspath() {
  scan "$1" abspath -nIF '/home/'
}
rule_banned() { # file rel
  case "$(basename "$1")" in pnpm-lock.yaml|package-lock.json|yarn.lock) return ;; esac
  case "$2" in
    paperclip/*) scan "$1" banned -nIiF -f "$TERMS_PC" ;;
    *) scan "$1" banned -nIiF -f "$TERMS" ;;
  esac
  scan "$1" banned -nIE -f "$PATS"
}

# Path is excluded if any component is a client dir, build output, .git or .superpowers.
excluded() {
  case "/$1/" in
    */clients/*|*/node_modules/*|*/dist/*|*/storybook-static/*|*/coverage/*|*/.vite/*|*/.git/*|*/.superpowers/*) return 0 ;;
  esac
  return 1
}

lint_file() {
  [ -f "$1" ] || return 0
  local rel="${1#"$ROOT"/}"
  rel="${rel#./}"
  # Instruction-file rules do not apply to the Paperclip copy.
  case "$rel" in
    paperclip/*) ;;
    *)
      rule_routing "$1"; rule_uuid "$1"; rule_carveout "$1"
      rule_board_literal "$1"; rule_abspath "$1" ;;
  esac
  rule_banned "$1" "$rel"
}

if [ $# -gt 0 ]; then
  for p in "$@"; do
    rel="${p#"$ROOT"/}"
    excluded "$rel" && continue
    if [ -d "$p" ]; then
      while IFS= read -r f; do excluded "${f#"$ROOT"/}" || lint_file "$f"; done < <(find "$p" -type f)
    elif [ -f "$p" ]; then lint_file "$p"
    else echo "lint-instructions.sh: no such path: $p" >&2; exit 2; fi
  done
else
  # Default scan: the files git would commit (tracked, plus untracked ones that are not
  # git-ignored), so ignored session and runtime files never trip the gate.
  # The linter's own fixtures and tests break the rules on purpose.
  git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || { echo "lint-instructions.sh: $ROOT is not a git checkout; pass paths explicitly" >&2; exit 2; }
  while IFS= read -r -d '' f; do
    excluded "$f" && continue
    case "$f" in scripts/lint/*|scripts/lint-instructions.sh) continue ;; esac
    lint_file "$f"
  done < <(git -C "$ROOT" ls-files -z --cached --others --exclude-standard | sort -zu)
fi
exit $hits
