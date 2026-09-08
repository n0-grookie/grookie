#!/bin/sh
# Install the launchd jobs that keep the local model server and the Discord bridge
# running - across crashes and, more importantly, across reboots.
#
# Why this exists: on 2026-09-05 the box rebooted at 20:24 UTC and nothing brought
# either process back. Grookie was unreachable for 2.5 days until someone started the
# bridge by hand, and one scheduled job was marked missed because its scheduler was
# down with everything else.
#
#   sudo ./deploy/install.sh                      # system daemons: start at boot, no login needed
#   ./deploy/install.sh --mode agent              # per-user agents (only while that user is logged in)
#   ./deploy/install.sh --only bridge --dry-run   # render + lint, change nothing
#   sudo ./deploy/install.sh --take-over          # stop manually running copies first
#   sudo ./deploy/install.sh --status
#   sudo ./deploy/install.sh --uninstall
#
# daemon mode is the default and the only mode that survives a reboot on a box where
# nobody logs in as the Grookie user (check with: stat -f '%Su' /dev/console).
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TEMPLATES="$ROOT/deploy/launchd"
PREFIX=computer.n0.grookie
LLAMA_LABEL=$PREFIX.llama-server
BRIDGE_LABEL=$PREFIX.bridge

MODE=daemon
ONLY=all
ACTION=install
DRY=0
TAKE_OVER=0
TARGET_USER=${GROOKIE_USER:-}
NODE_BIN=${NODE_BIN:-}

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE=${2:-}; shift 2 ;;
    --only) ONLY=${2:-}; shift 2 ;;
    --user) TARGET_USER=${2:-}; shift 2 ;;
    --node) NODE_BIN=${2:-}; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --take-over) TAKE_OVER=1; shift ;;
    --uninstall) ACTION=uninstall; shift ;;
    --status) ACTION=status; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n\n' "$1" >&2; usage; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*" >&2; }
die() { printf 'FATAL %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "launchd jobs are macOS only"
case "$MODE" in daemon|agent) ;; *) die "--mode must be daemon or agent" ;; esac
case "$ONLY" in all|llama|bridge) ;; *) die "--only must be all, llama or bridge" ;; esac

# --- who are we installing for -----------------------------------------------------
# The repo owner is the account Grookie runs as; --user overrides it.
[ -n "$TARGET_USER" ] || TARGET_USER=$(stat -f '%Su' "$ROOT")
TARGET_UID=$(id -u "$TARGET_USER") || die "no such user: $TARGET_USER"
TARGET_HOME=$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
[ -n "$TARGET_HOME" ] || die "cannot find home directory for $TARGET_USER"
LOG_DIR="$TARGET_HOME/Library/Logs/grookie"

if [ "$MODE" = daemon ]; then
  DOMAIN=system
  JOB_DIR=/Library/LaunchDaemons
  [ "$(id -u)" = "0" ] || die "daemon mode installs into $JOB_DIR; rerun with sudo (or use --mode agent)"
else
  DOMAIN="gui/$TARGET_UID"
  JOB_DIR="$TARGET_HOME/Library/LaunchAgents"
  if [ "$(id -u)" != "$TARGET_UID" ]; then
    die "agent mode must run as $TARGET_USER (currently $(id -un))"
  fi
fi

CONSOLE_USER=$(stat -f '%Su' /dev/console 2>/dev/null || echo none)
if [ "$MODE" = agent ]; then
  warn "agent mode only starts when $TARGET_USER has a GUI login session"
  warn "console user right now is '$CONSOLE_USER' - if that is not $TARGET_USER, a reboot will not bring Grookie back"
fi
if [ "$CONSOLE_USER" != "$TARGET_USER" ]; then
  say "note: nobody is logged into the GUI as $TARGET_USER (console user: $CONSOLE_USER) - daemon mode is the right choice"
fi
SLEEP_SETTING=$(pmset -g 2>/dev/null | awk '/^sleep[ \t]/{print $2}' | head -1)
if [ -n "$SLEEP_SETTING" ] && [ "$SLEEP_SETTING" != "0" ]; then
  warn "system sleep is $SLEEP_SETTING min; a sleeping box is a dark Grookie. Fix: sudo pmset -a sleep 0"
fi

# --- which node -------------------------------------------------------------------
if [ -z "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node || true)
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  die "no node binary found; pass --node /abs/path/to/node (launchd jobs do not inherit your shell PATH)"
fi
NODE_DIR=$(dirname "$NODE_BIN")
RUN_PATH="$NODE_DIR:$TARGET_HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

say "user       $TARGET_USER (uid $TARGET_UID, home $TARGET_HOME)"
say "mode       $MODE ($JOB_DIR, launchd domain $DOMAIN)"
say "node       $NODE_BIN"
say "logs       $LOG_DIR/{llama-server,bridge}.log (launchd appends)"

# --- refusing to run two of anything ---------------------------------------------
# Match on the entrypoint name, not the absolute path: `npm run start` runs the bridge
# as `node dist/main.js`, so an absolute-path pattern would miss it.
BRIDGE_PIDS=$("$ROOT/deploy/pids-of.sh" "dist/main.js" "(^|/)node$" || true)
MODEL_UP=0
if command -v curl >/dev/null 2>&1 && curl -sf --max-time 5 http://127.0.0.1:8080/health >/dev/null 2>&1; then
  MODEL_UP=1
fi

if [ "$ACTION" = install ] && { [ -n "$BRIDGE_PIDS" ] || [ "$MODEL_UP" = 1 ]; }; then
  say ""
  say "Something is already running that launchd would fight with:"
  [ -n "$BRIDGE_PIDS" ] && say "  bridge        pid(s) $(echo "$BRIDGE_PIDS" | tr '\n' ' ')"
  [ "$MODEL_UP" = 1 ] && say "  model server  already answering on :8080"
  if [ "$DRY" = 1 ]; then
    say "  (dry run: a real install stops here unless --take-over)"
  elif [ "$TAKE_OVER" != 1 ]; then
    say ""
    say "Stop them first, or rerun with --take-over. Two bridges on one bot token fight"
    say "over the gateway, and two model servers cannot both hold the weights."
    say ""
    say "Restarting the bridge also ends every live Discord session, including this turn"
    say "if you are running it from inside Grookie - a human should do it."
    exit 3
  fi
  if [ "$DRY" != 1 ] && [ "$TAKE_OVER" = 1 ]; then
    [ -n "$BRIDGE_PIDS" ] && kill $BRIDGE_PIDS 2>/dev/null || true
    if [ "$MODEL_UP" = 1 ]; then
      pids=$("$ROOT/deploy/pids-of.sh" "llama-server" "(^|/)llama-server$" || true)
      [ -n "$pids" ] && kill $pids 2>/dev/null || true
    fi
    say "sent SIGTERM to the manual copies; a stubborn model server needs a human"
    sleep 3
  fi
fi

# --- render ----------------------------------------------------------------------
TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

render() { # $1 template, $2 label, $3 script, $4 out
  sed \
    -e "s|__LABEL__|$2|g" \
    -e "s|__SCRIPT__|$3|g" \
    -e "s|__WORKDIR__|$ROOT|g" \
    -e "s|__HOME__|$TARGET_HOME|g" \
    -e "s|__PATH__|$RUN_PATH|g" \
    -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__LOGDIR__|$LOG_DIR|g" \
    -e "s|^__USERNAME__$|  <key>UserName</key><string>$TARGET_USER</string>|" \
    "$1" > "$4"
  if [ "$MODE" = agent ]; then
    sed -i '' '/__USERNAME__/d' "$4"
  fi
  plutil -lint "$4" >/dev/null || die "rendered plist is invalid: $4"
}

want_llama=0; want_bridge=0
case "$ONLY" in all) want_llama=1; want_bridge=1 ;; llama) want_llama=1 ;; bridge) want_bridge=1 ;; esac

if [ "$want_llama" = 1 ]; then
  render "$TEMPLATES/llama-server.plist.in" "$LLAMA_LABEL" "$ROOT/deploy/run-llama-server.sh" "$TMP/$LLAMA_LABEL.plist"
fi
if [ "$want_bridge" = 1 ]; then
  render "$TEMPLATES/bridge.plist.in" "$BRIDGE_LABEL" "$ROOT/deploy/run-bridge.sh" "$TMP/$BRIDGE_LABEL.plist"
fi

# --- status / uninstall ---------------------------------------------------------
plists() {
  [ "$want_llama" = 1 ] && printf '%s\n' "$LLAMA_LABEL"
  [ "$want_bridge" = 1 ] && printf '%s\n' "$BRIDGE_LABEL"
}

if [ "$ACTION" = status ]; then
  for label in $(plists); do
    say ""
    say "== $label"
    launchctl print "$DOMAIN/$label" 2>&1 | grep -E "state|pid|last exit code|path =|runs =" | head -8 \
      || say "   not loaded in $DOMAIN"
  done
  say ""
  say "model health: $(curl -sf --max-time 5 http://127.0.0.1:8080/health || echo 'no answer')"
  [ -f "$LOG_DIR/bridge.log" ] && say "last bridge log lines:" && tail -4 "$LOG_DIR/bridge.log"
  exit 0
fi

if [ "$ACTION" = uninstall ]; then
  for label in $(plists); do
    say "bootout $DOMAIN/$label"
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || say "   (was not loaded)"
    if [ -f "$JOB_DIR/$label.plist" ]; then
      say "remove $JOB_DIR/$label.plist"
      [ "$DRY" = 1 ] || rm -f "$JOB_DIR/$label.plist"
    fi
  done
  say "note: whatever launchd started is stopped with it, so Grookie goes down when this finishes"
  exit 0
fi

# --- install --------------------------------------------------------------------
if [ "$DRY" = 1 ]; then
  say ""
  say "--dry-run, rendered and linted ok:"
  for label in $(plists); do
    say ""
    say "--- $JOB_DIR/$label.plist"
    cat "$TMP/$label.plist"
  done
  say ""
  say "would: mkdir -p $LOG_DIR; copy the above into $JOB_DIR; bootout+bootstrap in $DOMAIN"
  exit 0
fi

install -d -o "$TARGET_UID" -g "$(id -g "$TARGET_USER")" "$LOG_DIR"
for label in $(plists); do
  install -m 0644 "$TMP/$label.plist" "$JOB_DIR/$label.plist"
  [ "$MODE" = daemon ] && chown root:wheel "$JOB_DIR/$label.plist"
  launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$JOB_DIR/$label.plist"
  say "installed $label"
done

say ""
say "Done. Both jobs start now and again at every boot."
say "The model takes many minutes to load, so the bridge logs 'waiting for model' first"
say "and prints 'ready pid=... sha=...' when it is actually serving Discord."
say ""
say "Verify without rebooting:  sudo ./deploy/install.sh --status"
say "Verify properly (the real test): reboot, then check --status after ~15 minutes."
say "Restart the bridge later:  ./deploy/restart.sh   (build gate, snapshot, rollback on failure)"
