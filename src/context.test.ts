import assert from "node:assert/strict";
import test from "node:test";

import {
  formatReplyPrefix,
  formatTurn,
  removeGrookieMention,
  type ContextMessage,
} from "./context.js";

const message = (id: string, content: string): ContextMessage => ({
  id,
  authorId: `user-${id}`,
  authorName: `User ${id}`,
  timestamp: "2026-08-28 08:00 UTC",
  content,
});

test("removes both Discord mention forms", () => {
  assert.equal(
    removeGrookieMention("hi <@123> and <@!123>", "123"),
    "hi and",
  );
});

test("formats a turn without repeating thread context", () => {
  assert.equal(formatTurn(message("2", "help")), "[2026-08-28 08:00 UTC] User 2: help");
});

test("formats a reply prefix", () => {
  assert.equal(
    formatReplyPrefix("Philipp", "2026-08-28 08:00 UTC"),
    "(responding to Philipp's message at 2026-08-28 08:00 UTC)",
  );
});
