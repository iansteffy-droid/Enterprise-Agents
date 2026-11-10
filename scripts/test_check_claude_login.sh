#!/usr/bin/env bash
# Tests check-claude-login.sh with a stubbed `claude`; never touches ~/.claude.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SH="$DIR/check-claude-login.sh"
fail=0
check() { if "${@:2}"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/empty" "$TMP/logged-in"
printf '#!/usr/bin/env bash\necho ok\nexit 0\n' > "$TMP/bin/claude"
chmod +x "$TMP/bin/claude"
echo '{"claudeAiOauth":{"accessToken":"fake"}}' > "$TMP/logged-in/.credentials.json"

out="$(PATH="$TMP/bin:$PATH" "$SH" --config-dir "$TMP/empty" 2>&1)"; rc=$?
check "no credentials file exits 1" test "$rc" = 1
check "prints login hint" grep -qF "Run: CLAUDE_CONFIG_DIR=$TMP/empty claude login" <<<"$out"

out="$(PATH="$TMP/bin:$PATH" "$SH" --config-dir "$TMP/logged-in" 2>&1)"; rc=$?
check "credentials + working claude exits 0" test "$rc" = 0

# Subscription only: the probe never authenticates with an API key from the environment.
printf '#!/usr/bin/env bash\n[ -z "${ANTHROPIC_API_KEY+x}" ] || { echo "api key leaked" >&2; exit 1; }\necho ok\n' > "$TMP/bin/claude"
out="$(ANTHROPIC_API_KEY=sk-test PATH="$TMP/bin:$PATH" "$SH" --config-dir "$TMP/logged-in" 2>&1)"; rc=$?
check "ANTHROPIC_API_KEY is unset for the probe" test "$rc" = 0

printf '#!/usr/bin/env bash\nexit 1\n' > "$TMP/bin/claude"
out="$(PATH="$TMP/bin:$PATH" "$SH" --config-dir "$TMP/logged-in" 2>&1)"; rc=$?
check "failing claude exits 1 with hint" test "$rc" = 1
check "failing claude prints hint" grep -qF "claude login" <<<"$out"

exit "$fail"
