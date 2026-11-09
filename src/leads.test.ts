import assert from "node:assert/strict";
import test from "node:test";

import {
  isLeadReaction,
  leadPointer,
  leadSeedTurn,
  leadThreadName,
  type LeadIntakeConfig,
  type LeadSource,
} from "./leads.js";

const config: LeadIntakeConfig = {
  channelId: "1234567890123456789",
  emoji: "🤝",
  scriptPath: "/opt/grookie/scripts/lead-add.py",
};

const source = (overrides: Partial<LeadSource> = {}): LeadSource => ({
  authorName: "Ada",
  timestamp: "2026-11-05 20:02 UTC",
  content: "company X asked about iroh relay quotas",
  url: "https://discord.com/channels/949/129/456",
  channelName: "iroh-dev",
  reactorNames: ["Bo"],
  attachmentCount: 0,
  ...overrides,
});

test("matches the flag emoji with or without a variation selector", () => {
  assert.equal(isLeadReaction("🤝", config), true);
  assert.equal(isLeadReaction("🤝\uFE0F", config), true);
  assert.equal(isLeadReaction("🤝 ", config), true);
  assert.equal(isLeadReaction("👍", config), false);
  assert.equal(isLeadReaction(null, config), false);
});

test("the pointer carries author, channel, reactor and link", () => {
  const pointer = leadPointer(source(), config.emoji);
  assert.match(pointer, /Bo/);
  assert.match(pointer, /Ada/);
  assert.match(pointer, /#iroh-dev/);
  assert.match(pointer, /2026-11-05 20:02 UTC/);
  assert.match(pointer, /https:\/\/discord\.com\/channels\/949\/129\/456/);
  assert.match(pointer, /> company X asked about iroh relay quotas/);
});

test("a long message is quoted within Discord's message limit", () => {
  const pointer = leadPointer(source({ content: "a".repeat(9_000) }), config.emoji);
  assert.ok(pointer.length < 2_000, `pointer was ${pointer.length} characters`);
  assert.match(pointer, /…/);
});

test("attachments are counted, not silently dropped", () => {
  assert.match(
    leadPointer(source({ attachmentCount: 1 }), config.emoji),
    /1 attachment Grookie cannot see/,
  );
  assert.match(
    leadPointer(source({ attachmentCount: 3 }), config.emoji),
    /3 attachments Grookie cannot see/,
  );
  assert.doesNotMatch(leadPointer(source(), config.emoji), /attachment/);
});

test("every line of a multiline quote stays quoted", () => {
  const pointer = leadPointer(source({ content: "one\ntwo" }), config.emoji);
  assert.match(pointer, /> one\n> two/);
});

test("a message with no text still gets a pointer", () => {
  const pointer = leadPointer(source({ content: "   " }), config.emoji);
  assert.match(pointer, /no text/);
});

test("thread names stay titled and inside Discord's limit", () => {
  assert.equal(
    leadThreadName(source({ content: "Company X wants a call" })),
    "Lead: Company X wants a call",
  );
  assert.equal(leadThreadName(source({ content: "   " })), "Lead: message from Ada");
  const long = leadThreadName(source({ content: "word ".repeat(60) }));
  assert.ok(long.length <= 100, `thread name was ${long.length} characters`);
  assert.match(long, /…$/);
});

test("the seed turn asks exactly the two questions", () => {
  const seed = leadSeedTurn(
    source(),
    "https://discord.com/channels/949/129/789",
    config,
  );
  assert.match(seed, /lead intake/);
  assert.match(seed, /what company do they work for\? name, description, domain/);
  assert.match(seed, /should we create a feature request\?/);
  assert.match(seed, /run `--features` for the/);
  assert.match(seed, /the body is the message text above, verbatim/);
  // Nothing else gets asked: no contact details, no deal size.
  assert.match(seed, /Do not ask for contact details or deal size/);
  assert.doesNotMatch(seed, /who the lead is|email, Discord, GitHub/);
});

test("the seed turn shows the record command with the body inline", () => {
  const seed = leadSeedTurn(source(), "https://discord.com/channels/949/129/789", config);
  assert.match(seed, /python3 \/opt\/grookie\/scripts\/lead-add\.py --company/);
  assert.match(seed, /--company-description/);
  assert.match(seed, /--feature '<title from --features>'/);
  assert.match(seed, /--source-url https:\/\/discord\.com\/channels\/949\/129\/456/);
  assert.match(seed, /--thread-url https:\/\/discord\.com\/channels\/949\/129\/789 --body - <<'LEAD'/);
  assert.match(seed, /--no-feature/);
  // The quoted message is copied in as the body, delimiter at column 0.
  assert.match(
    seed,
    /<<'LEAD'\ncompany X asked about iroh relay quotas\nLEAD\n/,
  );
});

test("a long message is not copied into the seed a second time", () => {
  const seed = leadSeedTurn(
    source({ content: "a".repeat(9_000) }),
    "https://discord.com/channels/949/129/789",
    config,
  );
  assert.match(seed, /<paste the quoted message above, verbatim>/);
  // Quoted once at the top, and not repeated into the command.
  const body = seed.match(/<<'LEAD'\n([\s\S]*?)\nLEAD/)?.[1];
  assert.equal(body, "<paste the quoted message above, verbatim>");
});

// discord.js drops MESSAGE_REACTION_ADD without a trace when the message is not cached
// and no Message partial is configured, so a flag on an old message would look like the
// feature simply never fires. Cheapest place to catch that is the client options.
test("the client subscribes to reactions in a way that can deliver old messages", async () => {
  const { GatewayIntentBits, Partials } = await import("discord.js");
  const { CLIENT_OPTIONS } = await import("./discord.js");
  const { intents, partials } = CLIENT_OPTIONS;
  assert.ok(Array.isArray(intents) && intents.includes(GatewayIntentBits.GuildMessageReactions));
  assert.ok(Array.isArray(partials) && partials.includes(Partials.Message));
  assert.ok(Array.isArray(partials) && partials.includes(Partials.Reaction));
});
