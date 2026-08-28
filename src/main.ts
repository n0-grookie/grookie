import "dotenv/config";

import { loadConfig } from "./config.js";
import { DiscordController } from "./discord.js";
import { GrookieAgent } from "./agent.js";
import { StateStore } from "./store.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new StateStore(config.statePath);
  await store.load();

  const agent = new GrookieAgent(config, store);
  await agent.initialize();

  const discord = new DiscordController(config, agent, store);
  await discord.start();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
