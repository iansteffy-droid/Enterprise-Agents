#!/usr/bin/env bash
# Tests seed-agent-adapter.sh against a throwaway test instance (3201), never the kit instance.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$(cd "$DIR/.." && pwd)"
SH="$DIR/paperclip-instance.sh"
ARGS=(--instance paperclip-enterprise-test --port 3201 --db-port 54331)
API=http://127.0.0.1:3201
TMP="$(mktemp -d)"
fail=0
check() { if "${@:2}"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }
cleanup() { "$SH" stop "${ARGS[@]}" >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT

post() { curl -sf --max-time 20 -X POST -H 'content-type: application/json' -d @"$2" "$API$1"; }

[ -x "$DIR/seed-agent-adapter.sh" ] || { echo "FAIL: seed-agent-adapter.sh missing"; exit 1; }
"$SH" start "${ARGS[@]}" || { echo "FAIL: instance start"; exit 1; }

echo '{"name":"Seed Test Co"}' > "$TMP/c.json"
CID="$(post /api/companies "$TMP/c.json" | jq -r .id)"
check "company created" test -n "$CID" -a "$CID" != null
for n in "Guinan" "Riker"; do
  jq -n --arg n "$n" '{name:$n,role:"general",adapterType:"claude_local",adapterConfig:{model:"x",timeoutSec:1800}}' > "$TMP/a.json"
  post "/api/companies/$CID/agents" "$TMP/a.json" > "$TMP/$n.out"
done

cat > "$TMP/env" <<'ENVF'
AGENTS_REPO=/kit/root
PRODUCT_OPERATOR_TREE=/work/op
GIT_GUARD_MAINLINE=master,main
[role:guinan]
GIT_GUARD_PUSH_ALLOW=retro/*
ENVF

out1="$("$DIR/seed-agent-adapter.sh" --api "$API" --company "$CID" --env-file "$TMP/env" 2>&1)"; echo "$out1"
check "first run updated two agents" test "$(grep -c '^updated ' <<<"$out1")" = 2

agents="$(curl -sf "$API/api/companies/$CID/agents")"
for n in Guinan Riker; do
  id="$(jq -r --arg n "$n" '.[]|select(.name==$n)|.id' <<<"$agents")"
  a="$(curl -sf "$API/api/agents/$id")"
  check "$n extraArgs" test "$(jq -c .adapterConfig.extraArgs <<<"$a")" = '["--settings","/kit/root/hooks/claude-settings.json"]'
  check "$n AGENTS_REPO" test "$(jq -r .adapterConfig.env.AGENTS_REPO.value <<<"$a")" = /kit/root
  check "$n keeps model" test "$(jq -r .adapterConfig.model <<<"$a")" = x
  if [ "$n" = Guinan ]; then
    check "Guinan push allow" test "$(jq -r .adapterConfig.env.GIT_GUARD_PUSH_ALLOW.value <<<"$a")" = 'retro/*'
  else
    check "Riker has no push allow" test "$(jq -r '.adapterConfig.env.GIT_GUARD_PUSH_ALLOW // "none"' <<<"$a")" = none
  fi
done

out2="$("$DIR/seed-agent-adapter.sh" --api "$API" --company "$CID" --env-file "$TMP/env" 2>&1)"; echo "$out2"
check "second run unchanged twice" test "$(grep -c '^unchanged ' <<<"$out2")" = 2

# Error paths against a stub API (no instance needed).
cat > "$TMP/stub.py" <<'PY'
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, code, body):
        b = body.encode(); self.send_response(code)
        self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path.endswith("/agents"):
            self.reply(200, {"bad": '{"error":"nope"}', "empty": "[]", "ok": '[{"id":"a1","name":"Riker"}]'}[MODE])
        else:
            self.reply(200, '{"id":"a1","name":"Riker","adapterConfig":{}}')
    def do_PATCH(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        self.reply(422, '{"error":"adapterConfig invalid: stub-reason"}')
MODE = sys.argv[2]
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
stub() { # mode port
  python3 "$TMP/stub.py" "$2" "$1" & SPID=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do curl -s -m1 "http://127.0.0.1:$2/x" -o /dev/null && break; sleep 0.3; done
  "$DIR/seed-agent-adapter.sh" --api "http://127.0.0.1:$2" --company c --env-file "$TMP/env" >"$TMP/o" 2>&1; RC=$?
  kill $SPID 2>/dev/null; wait $SPID 2>/dev/null
}
stub bad 3291
check "non-array list exits 1 with message" bash -c "test $RC = 1 && grep -q 'not a JSON array' $TMP/o"
stub empty 3292
check "empty list exits 1 with message" bash -c "test $RC = 1 && grep -q 'has no agents' $TMP/o"
stub ok 3293
check "PATCH 422 exits 1 and prints the body" bash -c "test $RC = 1 && grep -q 'stub-reason' $TMP/o && grep -q 'HTTP 422' $TMP/o"
exit $fail
