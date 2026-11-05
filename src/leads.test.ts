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

test("the seed turn tells Grookie where to record the lead", () => {
  const seed = leadSeedTurn(
    source(),
    "https://discord.com/channels/949/129/789",
    config,
  );
  assert.match(seed, /lead intake/);
  assert.match(seed, /Contact flagged as Lead/);
  assert.match(seed, /python3 \/opt\/grookie\/scripts\/lead-add\.py/);
  assert.match(seed, /--source-url https:\/\/discord\.com\/channels\/949\/129\/456/);
  assert.match(seed, /--thread-url https:\/\/discord\.com\/channels\/949\/129\/789/);
  // The interview is the point of the thread, so the instructions to ask have to be in it.
  assert.match(seed, /who the lead is/);
});
