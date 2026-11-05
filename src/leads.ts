import { fileURLToPath } from "node:url";

/**
 * Lead intake: someone reacts with a flag emoji on a message, which means "this is
 * a sales signal, write it down". The bridge's whole job here is to turn that
 * reaction into a thread in the leads channel and seed it with enough context that
 * Grookie can interview whoever is reading. The questions themselves are Grookie's
 * call - see `leadSeedTurn` for what the opening turn says.
 *
 * Everything in this module is pure so the decisions are testable without a gateway.
 */

export interface LeadIntakeConfig {
  /** Channel the intake thread is created in (`#leads`). */
  channelId: string;
  /** Reaction that triggers an intake, compared with `normalizeEmoji`. */
  emoji: string;
  /** Script that records the contact once the interview has answers. */
  scriptPath: string;
}

/** Discord's own hard limit is 2000; leave room for the framing around the quote. */
export const QUOTE_LIMIT = 1_600;

/**
 * `dist/leads.js` and `src/leads.ts` both sit one level under the repo root, so the
 * same relative URL resolves in the built bridge and under `npm run dev`.
 */
export const DEFAULT_SCRIPT_PATH = fileURLToPath(
  new URL("../scripts/lead-add.py", import.meta.url),
);

/**
 * Unicode emoji often arrive with (or without) VARIATION SELECTOR-16 depending on the
 * client, and custom emoji are matched by name. Neither should depend on that detail.
 */
export function normalizeEmoji(name: string): string {
  return name.replace(/\uFE0F/g, "").trim();
}

export function isLeadReaction(
  emojiName: string | null | undefined,
  config: LeadIntakeConfig,
): boolean {
  if (!emojiName) return false;
  return normalizeEmoji(emojiName) === normalizeEmoji(config.emoji);
}

export interface LeadSource {
  /** Who wrote the reacted-to message. */
  authorName: string;
  /** Formatted with `formatTimestamp`, so the thread reads like every other turn. */
  timestamp: string;
  content: string;
  /** Jump link to the original message. */
  url: string;
  /** Channel the reaction landed in, for the pointer message. */
  channelName: string;
  /** People whose reaction we saw; usually one. */
  reactorNames: string[];
  attachmentCount: number;
}

/**
 * Posted into `#leads` when the flagged message lives somewhere else, because Discord
 * threads always branch from a message in their own channel - a thread cannot be
 * created in `#leads` for a message that is not in `#leads`.
 */
export function leadPointer(source: LeadSource, emoji: string): string {
  const reactors = source.reactorNames.join(", ") || "someone";
  const lines = [
    `${emoji} lead flag from ${reactors} - message by ${source.authorName} in #${source.channelName}, ${source.timestamp}`,
    "",
    quote(source.content, source.attachmentCount),
    "",
    `Original: ${source.url}`,
    "",
    "Grookie is asking about this here so the CRM record gets one home.",
  ];
  return lines.join("\n");
}

/**
 * The seed turn: what Grookie sees as the opening message of the intake thread. It
 * has to carry the whole context by itself, because a new thread starts blank.
 */
export function leadSeedTurn(
  source: LeadSource,
  threadUrl: string,
  config: LeadIntakeConfig,
): string {
  const reactors = source.reactorNames.join(", ") || "someone";
  return [
    `lead intake - ${normalizeEmoji(config.emoji)} reaction from ${reactors} on a message by ${source.authorName} in #${source.channelName} (${source.timestamp}).`,
    "",
    quote(source.content, source.attachmentCount, source.url),
    "",
    "Someone here will answer - ask in the open, and keep to a group chat's patience:",
    "two or three questions at a time, and skip whatever the message already answers.",
    "",
    "The record is a Contact flagged as Lead in the n0me CRM. It needs:",
    "- the person: name, and however they are reachable (email, Discord, GitHub, LinkedIn, X)",
    "- the company: name, plus domain if anyone knows one",
    "- description: who they are, what they want, where this came from - include the original link",
    "- if a deal or money comes up, write it in the description instead of inventing numbers",
    "",
    "Open by asking who the lead is and which company they are at.",
    "Once the name and either a company or a way to reach them are in, record it:",
    "",
    `  python3 ${config.scriptPath} --name '<who>' --company '<company>' \\`,
    `    --email '<email>' --description '<who they are, what they want>' \\`,
    `    --source-url ${source.url} --thread-url ${threadUrl}`,
    "",
    "Add `--help` for the rest of the fields, or `--dry-run` to see the record first.",
    "If it says the contact already exists, do not force it - say so here and ask whether",
    "to update that contact instead. If nobody answers after one nudge, stop and say the",
    "intake was dropped rather than asking again.",
  ].join("\n");
}

/**
 * Thread titles are the only thing a scrolling reader sees, so lead with the shape of
 * the signal rather than a truncated sentence.
 */
export function leadThreadName(source: LeadSource): string {
  const snippet = (source.content.replace(/\s+/g, " ").trim() || `message from ${source.authorName}`)
    .slice(0, 68)
    .trimEnd();
  const suffix = source.content.replace(/\s+/g, " ").trim().length > 68 ? "…" : "";
  return `Lead: ${snippet}${suffix}`.slice(0, 100);
}

function quote(content: string, attachmentCount: number, url?: string): string {
  const trimmed = content.trim();
  const body = trimmed
    ? trimmed.length > QUOTE_LIMIT
      ? `${trimmed.slice(0, QUOTE_LIMIT).trimEnd()}\n> …`
      : trimmed
    : url
      ? `(no text - see ${url})`
      : "(no text)";
  const quoted = body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const note =
    attachmentCount > 0
      ? `(${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"} Grookie cannot see)`
      : undefined;
  return note ? `${quoted}\n${note}` : quoted;
}
