#!/bin/sh
# Start the local model server under launchd.
#
# Kept as its own job, separate from the Discord bridge, so a model crash does not
# take the controller down with it (and restarting the controller never bounces the
# 175 GB of weights).
#
# Exits 75 (EX_TEMPFAIL) when something else already owns the port: launchd retries
# the job after ThrottleInterval, which is what we want instead of a second load.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ -f "$DIR/llama.env" ] && . "$DIR/llama.env"
[ -f "$DIR/llama.env.local" ] && . "$DIR/llama.env.local"

log() {
  printf '[%s] llama %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

LLAMA_HOST=${LLAMA_HOST:-127.0.0.1}
LLAMA_PORT=${LLAMA_PORT:-8080}
HEALTH_URL="http://${LLAMA_HOST}:${LLAMA_PORT}/health"

if [ -z "${LLAMA_BIN:-}" ] || [ ! -x "$LLAMA_BIN" ]; then
  log "FATAL LLAMA_BIN is not executable: '${LLAMA_BIN:-<unset>}' (set it in $DIR/llama.env)"
  exit 78 # EX_CONFIG
fi
if [ -z "${LLAMA_MODEL:-}" ] || [ ! -f "$LLAMA_MODEL" ]; then
  log "FATAL model file not found: '${LLAMA_MODEL:-<unset>}' (set LLAMA_MODEL in $DIR/llama.env)"
  exit 78 # EX_CONFIG
fi

# The weights are far too big to hold twice. If the port already answers, someone
# (a manual run, or a job still shutting down) owns it - do not load a second copy.
if command -v curl >/dev/null 2>&1 && curl -sf --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  log "REFUSE something already serves $HEALTH_URL; not loading a second copy of the model"
  log "  if that is a manual llama-server you want replaced, stop it and launchd will retry"
  exit 75 # EX_TEMPFAIL
fi

log "starting ${LLAMA_BIN##*/} port=$LLAMA_PORT ctx=${LLAMA_CTX_SIZE:-?} parallel=${LLAMA_PARALLEL:-?} gpu_layers=${LLAMA_N_GPU_LAYERS:-?}"
log "model $LLAMA_MODEL"

exec "$LLAMA_BIN" \
  --model "$LLAMA_MODEL" \
  --host "$LLAMA_HOST" \
  --port "$LLAMA_PORT" \
  --ctx-size "${LLAMA_CTX_SIZE:-4096}" \
  --parallel "${LLAMA_PARALLEL:-1}" \
  --n-gpu-layers "${LLAMA_N_GPU_LAYERS:-0}" \
  --fit "${LLAMA_FIT:-off}"
