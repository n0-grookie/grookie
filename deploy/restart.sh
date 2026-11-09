#!/bin/sh
# Restart the Grookie bridge without risking a bad boot: gate on the checks, snapshot
# dist/, restart through launchd, wait for the readiness line, roll back if it never
# shows up.
#
#   ./deploy/restart.sh                  # build, restart, verify, roll back if broken
#   ./deploy/restart.sh --no-build       # restart the dist that is already there
#   ./deploy/restart.sh --wait 600       # cold model server? give it longer
#   ./deploy/restart.sh --dry-run
#
# If you are Grookie: do not run this on yourself. Restarting the bridge ends every
# live Discord session including your own turn, mid-token. Open a PR and let a human
# run it. The script enforces that (see the ancestry guard) unless you pass --force.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PREFIX=computer.n0.grookie
LABEL=$PREFIX.bridge

DO_BUILD=1
WAIT=300
DRY=0
FORCED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) DO_BUILD=0; shift ;;
    --wait) WAIT=${2:-300}; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --force) FORCED=1; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'FATAL %s\n' "$*" >&2; exit 1; }

# --- ancestry guard -------------------------------------------------------------
# If the bridge is anywhere above us, this restart kills our own turn.
if [ "$FORCED" != 1 ]; then
  p=$(ps -o ppid= -p $$ | tr -d ' ')
  while [ -n "$p" ] && [ "$p" != "0" ] && [ "$p" != "1" ]; do
    cmd=$(ps -o command= -p "$p" 2>/dev/null || true)
    case "$cmd" in
      *dist/main.js*)
        die "the bridge (pid $p) is an ancestor of this shell - restarting it kills you mid-turn.
     Have a human run: $0
     (or pass --force if you really mean it)" ;;
    esac
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
fi

# --- where does the running job live -------------------------------------------
TARGET_USER=${GROOKIE_USER:-$(stat -f '%Su' "$ROOT")}
TARGET_UID=$(id -u "$TARGET_USER") || die "no such user: $TARGET_USER"
TARGET_HOME=$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
LOG=${GROOKIE_BRIDGE_LOG:-$TARGET_HOME/Library/Logs/grookie/bridge.log}

DOMAIN=
if launchctl print "system/$LABEL" >/dev/null 2>&1; then
  DOMAIN=system
elif launchctl print "gui/$TARGET_UID/$LABEL" >/dev/null 2>&1; then
  DOMAIN="gui/$TARGET_UID"
else
  die "$LABEL is not installed in system or gui/$TARGET_UID - run ./deploy/install.sh first"
fi

say "job      $DOMAIN/$LABEL"
say "log      $LOG"
say "wait     ${WAIT}s for the readiness line"

if [ ! -f "$ROOT/dist/main.js" ]; then
  die "no $ROOT/dist/main.js - build it first (drop --no-build)"
fi

# --- gate -----------------------------------------------------------------------
if [ "$DO_BUILD" = 1 ]; then
  say ""
  say "== npm run typecheck"
  ( cd "$ROOT" && npm run typecheck )
  say "== npm test"
  ( cd "$ROOT" && npm test )
  say "== npm run build"
  ( cd "$ROOT" && npm run build )
else
  say "--no-build: restarting the dist that is already on disk"
fi

if [ "$DRY" = 1 ]; then
  say ""
  say "--dry-run: would snapshot dist/, kickstart $DOMAIN/$LABEL, then watch for 'ready pid=' in $LOG"
  say "           and restore the snapshot if it does not appear within ${WAIT}s"
  exit 0
fi

# --- snapshot -------------------------------------------------------------------
STAMP=$(date -u +%Y%m%d-%H%M%S)
PREV="$ROOT/.dist-prev-$STAMP"
cp -R "$ROOT/dist" "$PREV"
say "snapshot $PREV"
# Keep the three most recent snapshots.
ls -1dt "$ROOT"/.dist-prev-* 2>/dev/null | tail -n +4 | while read -r old; do
  say "prune    $old"
  rm -rf "$old"
done

OFFSET=0
[ -f "$LOG" ] && OFFSET=$(wc -c < "$LOG" | tr -d ' ')

wait_ready() { # $1 = seconds
  deadline=$(($(date +%s) + $1))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -f "$LOG" ]; then
      line=$(tail -c +"$((OFFSET + 1))" "$LOG" 2>/dev/null | grep -m1 'ready pid=' || true)
      if [ -n "$line" ]; then
        say "READY    $line"
        return 0
      fi
      tail -c +"$((OFFSET + 1))" "$LOG" 2>/dev/null | grep -E 'waiting for model|REFUSE|FATAL|Error' | tail -2 | sed 's/^/         /' || true
    fi
    sleep 5
  done
  return 1
}

say ""
say "== kickstart $DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"

if wait_ready "$WAIT"; then
  say ""
  say "ok - new build is serving. Snapshot kept at $PREV if you need it."
  exit 0
fi

say ""
say "no readiness line within ${WAIT}s - rolling back to $PREV"
rm -rf "$ROOT/dist"
cp -R "$PREV" "$ROOT/dist"
launchctl kickstart -k "$DOMAIN/$LABEL"
if wait_ready 120; then
  say "rolled back and serving the previous build. The new one is broken; fix forward."
else
  say "rollback did not come up either. This needs a human:"
  say "  tail -50 $LOG"
  say "  launchctl print $DOMAIN/$LABEL"
fi
exit 1
