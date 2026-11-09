#!/bin/sh
# pids-of.sh <substring> [program-regex]
#   print the pids whose command line contains <substring> and, if a program regex is
#   given, whose program name matches it.
#
#     pids-of.sh 'dist/main.js' '(^|/)node$'   # the bridge, and nothing else
#     pids-of.sh 'llama-server' '(^|/)llama-server$'
#
# Two things this works around:
#   * `pgrep -f` cannot read the argv of the hand-started, launchd-adopted bridge on
#     this machine, so a pgrep-based guard silently misses the process it exists to
#     detect. `ps` can read it.
#   * matching the whole command line also matches whoever asked us - a shell whose
#     argv contains the very string being searched for, or this script's own path.
#     Requiring the *program* to be node/llama-server keeps the answer to real
#     services. Filtering ancestors instead would be wrong: when Grookie runs a
#     command, the live bridge is one of its ancestors, and that is exactly the
#     process these guards must find.
set -eu

[ $# -ge 1 ] && [ $# -le 2 ] || { printf 'usage: %s <substring> [program-regex]\n' "$0" >&2; exit 2; }

GROOKIE_MATCH="$1"
GROOKIE_PROGRAM=${2:-}
GROOKIE_SELF=$$
export GROOKIE_MATCH GROOKIE_PROGRAM GROOKIE_SELF

ps -axo pid=,command= | awk '
  BEGIN {
    needle = ENVIRON["GROOKIE_MATCH"]
    program = ENVIRON["GROOKIE_PROGRAM"]
    self = ENVIRON["GROOKIE_SELF"]
  }
  {
    if ($1 == self) next
    line = $0
    sub(/^[ ]*[0-9]+[ ]+/, "", line)
    if (index(line, needle) == 0) next
    split(line, fields, /[ \t]+/)
    if (length(program) > 0 && fields[1] !~ program) next
    print $1
  }
'
