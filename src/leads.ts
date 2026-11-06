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
 *
 * Two questions and no more (okdistribute, 2026-11-06): the company, and whether this
 * is a feature request. Contact details and deal size are deliberately not asked - an
 * intake thread in front of colleagues stops being one when it turns into a form.
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
    "Someone here will answer. Ask these two, in the open, in one message:",
    "",
    "1. what company do they work for? name, description, domain.",
    "2. should we create a feature request? if yes, which one - run `--features` for the",
    "   current list. the body is the message text above, verbatim.",
    "",
    "That is all. Do not ask for contact details or deal size. If a person is needed for",
    `the record, take ${source.authorName} from the message above and say so.`,
    "",
    "Once the company is in and question two is answered, record it:",
    "",
    `  python3 ${config.scriptPath} --company '<name>' --company-description '<what this is about>' \\`,
    "    --domain '<domain, if anyone knows one>' --feature '<title from --features>' \\",
    `    --person-name '${source.authorName.replace(/\n/g, " ")}' \\`,
    `    --source-url ${source.url} --thread-url ${threadUrl} --body - <<'LEAD'`,
    ...bodyLines(source.content),
    "LEAD",
    "",
    "Use `--no-feature` instead of `--feature` and `--body` when the answer is that this",
    "is not a product request. `--dry-run` shows the record without writing it.",
    "If it says n0me already has that company or contact, do not force it - say so here",
    "and ask whether to update what is there. If nobody answers after one nudge, stop and",
    "say the intake was dropped rather than asking again.",
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

/**
 * The flagged text *is* the feature request body, so the example command carries it
 * instead of describing it. Long messages are not duplicated a second time into the
 * seed - they are quoted above already, and a small model copies short things better.
 */
function bodyLines(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 400) return ["<paste the quoted message above, verbatim>"];
  const lines = trimmed.split("\n");
  // A line equal to the delimiter would end the heredoc early.
  if (lines.some((line) => line === "LEAD")) return ["<paste the quoted message above, verbatim>"];
  return lines.map((line) => line || " ");
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
