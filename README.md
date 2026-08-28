# Grookie

Grookie is a small Discord controller for a local Letta agent running on the company Mac Studio.

The v1 behavior is intentionally narrow:

- Grookie only handles explicit `@Grookie` mentions.
- A Discord thread maps to one persistent Letta conversation.
- Mentions from members with an allowed Discord role create a thread automatically in any guild text channel.
- Recent qualifying mentions are scanned for up to 30 minutes after startup or reconnect; live and recovered messages use the same handler.
- Each turn includes a bounded recent snapshot of the Discord thread.
- The agent has no web, shell, filesystem, or company-action tools.

## Local development

Install dependencies and compile:

```sh
npm install
npm run typecheck
npm test
npm run build
```

Configure the local Letta model separately on Grookie. `GROOKIE_MODEL` is optional and should be
the exact model handle exposed by the local Letta provider. Qwen 3.8 Flash is the intended target,
but its serving layer must support Chat Completions and tool calling for the later tool-enabled
version.

Copy `.env.example` to `.env`, then fill in the values from Discord's quick-start guide. The
application ID is already prefilled from the test app. `PUBLIC_KEY` is retained for the guide but
is not used by this Gateway-based v1; `DISCORD_TOKEN` is the sensitive value the controller uses.

Set the remaining values before starting the controller:

```sh
cp .env.example .env
# Edit .env:
# DISCORD_TOKEN=...
# GROOKIE_ALLOWED_ROLE_IDS=role-id-1,role-id-2
# GROOKIE_MODEL=provider/model-id       # exact local Letta model handle
npm run dev
```

The Discord bot needs the `Message Content Intent` and permissions to read message history, send
messages, create public threads, and send messages in threads. Keep the Letta runtime local to
Grookie; this controller does not expose it over the network.

Thread and agent IDs are stored in `state/grookie.json`, which is deliberately gitignored. The
state file is written with restrictive permissions and atomically replaced after updates.

## Deferred

Web search/fetch will be added as controller-owned Letta SDK client tools with explicit request
limits. Narrowly authorized company actions come after that.
