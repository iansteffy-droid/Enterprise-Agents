#!/usr/bin/env bash
# Starts a second (test) instance, so the kit instance on 3200 is never disturbed.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SH="$DIR/paperclip-instance.sh"
ARGS=(--instance paperclip-enterprise-test --port 3201 --db-port 54331)
CFG="$HOME/.paperclip/instances/paperclip-enterprise-test/config.json"
fail=0
check() { if "${@:2}"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }
cleanup() { "$SH" stop "${ARGS[@]}" >/dev/null 2>&1; }
trap cleanup EXIT

"$SH" start "${ARGS[@]}"
check "health on 3201" curl -sf --max-time 5 http://127.0.0.1:3201/api/health -o /dev/null
check "config server.port == 3201" test "$(jq -r .server.port "$CFG" 2>/dev/null)" = 3201
check "config embeddedPostgresPort == 54331" test "$(jq -r .database.embeddedPostgresPort "$CFG" 2>/dev/null)" = 54331
check "other instance on 3100 untouched" curl -sf --max-time 5 http://127.0.0.1:3100/api/health -o /dev/null
"$SH" stop "${ARGS[@]}"
check "port 3201 closed after stop" bash -c '! curl -s --max-time 3 http://127.0.0.1:3201/api/health -o /dev/null'

# Fix 2: changed --db-port on a stopped instance with existing config -> exit 2, config unchanged
before="$(cat "$CFG")"
"$SH" start --instance paperclip-enterprise-test --port 3201 --db-port 54332 >/dev/null 2>&1
check "mismatched --db-port exits 2" test $? = 2
check "config unchanged after mismatch" test "$before" = "$(cat "$CFG")"

# Fix 1: failed health wait must not leave the server behind
PAPERCLIP_INSTANCE_HEALTH_TIMEOUT=2 "$SH" start "${ARGS[@]}" >/dev/null 2>&1
check "start with short health deadline exits 1" test $? = 1
check "no pid file after failed start" test ! -e "$HOME/.paperclip/instances/paperclip-enterprise-test/kit.pid"
sleep 1
check "port 3201 closed after failed start" bash -c '! curl -s --max-time 3 http://127.0.0.1:3201/api/health -o /dev/null'
exit $fail
