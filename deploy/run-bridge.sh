#!/bin/sh
# Start the Discord bridge under launchd, once the model server can answer.
#
# Two guards matter here:
#   * the model has to be loaded before the bridge is useful, and loading ~175 GB of
#     weights takes many minutes - so we wait instead of crash-looping the controller;
#   * a second bridge with the same bot token fights the first one for the gateway,
#     so we refuse to start if one is already running.
#
# Exits 75 (EX_TEMPFAIL) on either refusal: launchd retries after ThrottleInterval.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENTRY="$ROOT/dist/main.js"

log() {
  printf '[%s] bridge %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

HEALTH_URL=${GROOKIE_MODEL_HEALTH_URL:-http://127.0.0.1:8080/health}
MODEL_WAIT=${GROOKIE_MODEL_WAIT:-1800}
NODE_BIN=${NODE_BIN:-}

if [ -z "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node || true)
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  log "FATAL no node binary; set NODE_BIN in the launchd job EnvironmentVariables"
  exit 78 # EX_CONFIG
fi

# Match on the entrypoint name, not the absolute path: a bridge started by
# `npm run start` shows up as `node dist/main.js`.
OTHER=$("$ROOT/deploy/pids-of.sh" "dist/main.js" "(^|/)node$" || true)
if [ -n "$OTHER" ]; then
  log "REFUSE another bridge is already running: pid(s) $(echo "$OTHER" | tr '\n' ' ')"
  log "  two controllers on one bot token fight over the gateway - stop the other one first"
  exit 75 # EX_TEMPFAIL
fi

if ! command -v curl >/dev/null 2>&1; then
  log "WARN curl missing; starting without waiting for $HEALTH_URL"
else
  waited=0
  while ! curl -sf --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; do
    if [ "$waited" -ge "$MODEL_WAIT" ]; then
      log "FATAL model never became healthy at $HEALTH_URL within ${MODEL_WAIT}s"
      log "  check the llama-server log, or raise GROOKIE_MODEL_WAIT if this box is slow to load"
      exit 75 # EX_TEMPFAIL
    fi
    if [ "$waited" -eq 0 ] || [ $((waited % 60)) -eq 0 ]; then
      log "waiting for model at $HEALTH_URL (${waited}s elapsed)"
    fi
    sleep 5
    waited=$((waited + 5))
  done
  log "model healthy at $HEALTH_URL after ${waited}s"
fi

if [ ! -f "$ENTRY" ]; then
  log "dist/main.js missing; running npm run build"
  npm --prefix "$ROOT" run build
fi

# dotenv resolves .env against the working directory, and state/ is relative too.
cd "$ROOT"
log "exec $NODE_BIN $ENTRY"
exec "$NODE_BIN" "$ENTRY"
