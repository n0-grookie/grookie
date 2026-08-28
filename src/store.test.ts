import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { StateStore } from "./store.js";

test("persists and prunes processed message IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grookie-store-"));
  try {
    const path = join(directory, "state.json");
    const store = new StateStore(path);
    await store.load();
    store.markMessageProcessed("old", 100);
    store.markMessageProcessed("new", 200);
    await store.save();

    const reloaded = new StateStore(path);
    await reloaded.load();
    assert.equal(reloaded.hasProcessedMessage("old"), true);
    assert.equal(reloaded.hasProcessedMessage("new"), true);

    reloaded.pruneProcessedMessages(150);
    assert.equal(reloaded.hasProcessedMessage("old"), false);
    assert.equal(reloaded.hasProcessedMessage("new"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists prompt versions and can reset conversation mappings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grookie-store-"));
  try {
    const path = join(directory, "state.json");
    const store = new StateStore(path);
    await store.load();
    store.setAgentPromptVersion(2);
    store.setConversationId("thread", "conversation");
    store.resetConversations();
    await store.save();

    const reloaded = new StateStore(path);
    await reloaded.load();
    assert.equal(reloaded.agentPromptVersion, 2);
    assert.equal(reloaded.conversationId("thread"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
