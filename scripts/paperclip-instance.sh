#!/usr/bin/env bash
# Named kit Paperclip instance with its own ports, isolated from any other instance.
#
# Usage: paperclip-instance.sh {start|stop|status|url} [--instance <id>] [--port <n>] [--db-port <n>]
# Defaults: instance paperclip-enterprise, port 3200, db port 54330.
#
# Start path: the DEV RUNNER (`pnpm dev:once` in paperclip/), not `cli run -i`.
# Why: scripts/dev-runner.ts passes process.env through unchanged to the server,
# and the server resolves its config via PAPERCLIP_CONFIG (server/src/paths.ts)
# and PORT, so the env below selects the instance. We write config.json first
# (so nothing prompts) and export PAPERCLIP_CONFIG + PAPERCLIP_INSTANCE_ID + PORT.
# `dev:once` (not watch) is used so the server does not restart on file edits.
#
# Stop: we do NOT use `pnpm dev:stop`: it stops every dev service registered for
# this repo, which would also kill the kit instance when a test instance stops.
# Instead we SIGTERM exactly the process group we started (setsid; pid in kit.pid),
# then, if the embedded Postgres of THIS instance is still up, stop it via the
# postmaster.pid in this instance's own data dir.
#
# Never touches ~/.paperclip/instances/default or ports 3100/54329.
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTANCE="paperclip-enterprise"
PORT=3200
DB_PORT=54330

cmd="${1:-}"
[ $# -gt 0 ] && shift
while [ $# -gt 0 ]; do
  case "$1" in
    --instance) INSTANCE="${2:?--instance needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --db-port) DB_PORT="${2:?--db-port needs a value}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$INSTANCE" = "default" ] || [ "$PORT" = 3100 ] || [ "$DB_PORT" = 54329 ]; then
  echo "refusing: default instance / ports 3100 and 54329 are reserved for another project" >&2
  exit 2
fi
[[ "$INSTANCE" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "invalid instance id" >&2; exit 2; }

ROOT="$HOME/.paperclip/instances/$INSTANCE"
CONFIG="$ROOT/config.json"
PIDFILE="$ROOT/kit.pid"
LOGFILE="$ROOT/logs/kit.log"
URL="http://127.0.0.1:$PORT"

healthy() { curl -sf --max-time 3 "$URL/api/health" >/dev/null 2>&1; }
alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

write_config() {
  mkdir -p "$ROOT/logs" "$ROOT/data/backups" "$ROOT/data/storage"
  sed -e "s|__ROOT__|$ROOT|g" -e "s|__PORT__|$PORT|g" -e "s|__DB_PORT__|$DB_PORT|g" \
      -e "s|__NOW__|$(date -u +%Y-%m-%dT%H:%M:%S.000Z)|g" \
      "$KIT_DIR/templates/instance/config.template.json" > "$CONFIG"
}

do_start() {
  if [ -f "$CONFIG" ]; then
    local cp cd
    cp="$(jq -r .server.port "$CONFIG")"; cd="$(jq -r .database.embeddedPostgresPort "$CONFIG")"
    if [ "$cp" != "$PORT" ] || [ "$cd" != "$DB_PORT" ]; then
      echo "config $CONFIG has port=$cp db-port=$cd but flags say port=$PORT db-port=$DB_PORT; edit or remove the config to change them" >&2
      exit 2
    fi
  fi
  if alive; then
    echo "already running (pid $(cat "$PIDFILE")) at $URL"
    return 0
  fi
  [ -f "$CONFIG" ] || write_config
  mkdir -p "$ROOT/logs"
  (
    cd "$KIT_DIR/paperclip"
    PAPERCLIP_INSTANCE_ID="$INSTANCE" PAPERCLIP_CONFIG="$CONFIG" PORT="$PORT" \
      setsid nohup pnpm dev:once >"$LOGFILE" 2>&1 </dev/null &
    echo $! >"$PIDFILE"
  )
  local i
  for i in $(seq 1 "${PAPERCLIP_INSTANCE_HEALTH_TIMEOUT:-120}"); do
    if healthy; then echo "started (pid $(cat "$PIDFILE")) at $URL"; return 0; fi
    if ! alive; then echo "server exited during startup; see $LOGFILE" >&2; do_stop; return 1; fi
    sleep 1
  done
  echo "timed out waiting for $URL/api/health; see $LOGFILE" >&2
  do_stop
  return 1
}

pg_pid() {
  local f="$ROOT/db/postmaster.pid"
  [ -f "$f" ] && head -n1 "$f" || true
}

do_stop() {
  local pid i
  if alive; then
    pid="$(cat "$PIDFILE")"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for i in $(seq 1 30); do alive || break; sleep 1; done
    if alive; then kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; fi
  fi
  rm -f "$PIDFILE"
  # Embedded Postgres of this instance only (pid taken from its own data dir).
  local pg; pg="$(pg_pid)"
  if [ -n "$pg" ] && kill -0 "$pg" 2>/dev/null; then
    kill -TERM "$pg" 2>/dev/null || true
    for i in $(seq 1 20); do kill -0 "$pg" 2>/dev/null || break; sleep 1; done
  fi
  echo "stopped $INSTANCE"
}

do_status() {
  local state=stopped health=down
  alive && state=running
  healthy && health=ok
  echo "instance=$INSTANCE state=$state health=$health url=$URL"
  [ "$state" = running ]
}

case "$cmd" in
  start) do_start ;;
  stop) do_stop ;;
  status) do_status ;;
  url) echo "$URL" ;;
  *) echo "usage: $0 {start|stop|status|url} [--instance <id>] [--port <n>] [--db-port <n>]" >&2; exit 2 ;;
esac
