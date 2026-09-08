# Running Grookie as a service

Two processes make Grookie exist on this box:

```
llama-server        the model. ~175 GB of weights, takes many minutes to load.
dist/main.js        the Discord bridge. Starts one Letta app-server per live thread.
```

Before this directory existed, both were started by hand over ssh and adopted by
launchd (`ppid 1`). Nothing restarted them, so a reboot simply meant Grookie was
gone until a human noticed. That is what happened on 2026-09-05: reboot at 20:24
UTC, back at 03:17 on 2026-09-08, and a scheduled job went `missed` because its
scheduler was down with everything else.

## Install

```sh
sudo ./deploy/install.sh              # system daemons: start at boot, no login required
./deploy/install.sh --dry-run         # render + lint the plists, change nothing
sudo ./deploy/install.sh --status     # are the jobs loaded, what pid, what did the log say
sudo ./deploy/install.sh --uninstall
```

`--mode daemon` (default) puts plists in `/Library/LaunchDaemons` with
`UserName=<repo owner>`, which is the only mode that comes back after a reboot when
nobody logs into the GUI as that user. Check whose session is on the console with
`stat -f '%Su' /dev/console` - on this box it is `b5`, while Grookie runs as
`grookie`, so a `~/Library/LaunchAgents` job would only ever start if someone logged
into the GUI as `grookie`. `--mode agent` exists for a dev box where you do log in.

`--take-over` stops manually started copies first. Without it the installer refuses,
because two bridges on one bot token fight over the gateway and two model servers
cannot both hold the weights.

## Restarting after a code change

```sh
./deploy/restart.sh
```

That gates on `typecheck` + `test` + `build`, snapshots `dist/` to `.dist-prev-<ts>`,
does `launchctl kickstart -k`, then watches the log for the readiness line:

```
ready pid=10688 version=0.1.0 sha=6d8a063 model=... ts=2026-09-08T07:30:46.990Z
```

No readiness line within `--wait` seconds (default 300) means the new build is
broken, and it restores the snapshot and restarts that instead. Snapshots older than
the three newest are pruned.

The script refuses to run if the bridge is an ancestor of the shell calling it,
which is exactly the case when Grookie runs it on itself: the restart would end its
own turn mid-token. `--force` overrides. The intended flow is still: Grookie opens a
PR, a human reads it, a human restarts.

## Logs

launchd appends, so restarts no longer erase the evidence (the old
`npm run start > grookie.log` truncated on every start):

```
<home>/Library/Logs/grookie/llama-server.log
<home>/Library/Logs/grookie/bridge.log
```

## Order and failure behaviour

`run-bridge.sh` polls `http://127.0.0.1:8080/health` before exec'ing node, so a cold
model server makes the bridge log `waiting for model ...` rather than crash-loop.
Both wrappers exit `75` (EX_TEMPFAIL) when they decline to start - a second copy
already owns the port or the token - and launchd retries them after
`ThrottleInterval` (30s). `KeepAlive` is unconditional, so anything that exits is
brought back.

If a bad build crash-loops, launchd retries every 30s forever. `restart.sh` normally
catches that before it gets installed; if it does happen, `--uninstall` (or stopping
the job) plus restoring the newest `.dist-prev-*` gets you back to a known build.

## Not covered here

- Sleep: `pmset -g` must report `sleep 0` or the box goes dark on schedule. The
  installer warns if it does not.
- A crash of the *whole machine* still needs someone to press the power button.
