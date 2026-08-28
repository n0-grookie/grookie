import assert from "node:assert/strict";
import test from "node:test";

import {
  formatTurn,
  limitContext,
  removeGrookieMention,
  type ContextMessage,
} from "./context.js";

const message = (id: string, content: string): ContextMessage => ({
  id,
  authorId: `user-${id}`,
  authorName: `User ${id}`,
  timestamp: "2026-08-28T08:00:00.000Z",
  content,
});

test("removes both Discord mention forms", () => {
  assert.equal(
    removeGrookieMention("hi <@123> and <@!123>", "123"),
    "hi and",
  );
});

test("formats quoted context separately from the current request", () => {
  const result = formatTurn([message("1", "hello")], message("2", "help"));
  assert.match(result, /<discord-context>/);
  assert.match(result, /User 1/);
  assert.match(result, /Current request from User 2/);
});

test("limits context from the newest messages backwards", () => {
  const result = limitContext(
    [message("1", "one"), message("2", "two"), message("3", "three")],
    2,
    10_000,
  );
  assert.deepEqual(
    result.map((item) => item.id),
    ["2", "3"],
  );
});
