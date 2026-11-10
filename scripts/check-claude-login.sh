#!/usr/bin/env bash
# Verifies the kit's Claude config dir is logged in (subscription login only).
# Usage: check-claude-login.sh [--config-dir <dir>]
# Dir precedence: --config-dir, then $CLAUDE_CONFIG_DIR, then $HOME/.claude-paperclip-enterprise.
set -uo pipefail
DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude-paperclip-enterprise}"
while [ $# -gt 0 ]; do
  case "$1" in
    --config-dir) DIR="${2:-}"; [ -n "$DIR" ] || { echo "--config-dir needs a value" >&2; exit 2; }; shift 2 ;;
    *) echo "Usage: $0 [--config-dir <dir>]" >&2; exit 2 ;;
  esac
done
hint() { echo "Run: CLAUDE_CONFIG_DIR=$DIR claude login" >&2; exit 1; }
[ -f "$DIR/.credentials.json" ] || { echo "No credentials in $DIR" >&2; hint; }
# Subscription login only: an API key in the environment must not stand in for it.
env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR="$DIR" claude -p "reply with ok" --max-turns 1 >/dev/null 2>&1 || { echo "claude check failed for $DIR" >&2; hint; }
echo "Claude login OK ($DIR)"
