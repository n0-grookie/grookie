import "dotenv/config";

import { loadConfig } from "./config.js";
import { DiscordController } from "./discord.js";
import { GrookieAgent } from "./agent.js";
import { StateStore } from "./store.js";
import { formatReadiness, readiness } from "./readiness.js";

/**
 * Resolves when launchd (or a person) asks us to stop. Without this the process dies
 * on SIGKILL after launchd's grace period, which drops in-flight Discord turns harder
 * than a clean gateway disconnect does.
 */
function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const handler = (signal: NodeJS.Signals): void => {
      resolve(signal);
    };
    process.once("SIGTERM", handler);
    process.once("SIGINT", handler);
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new StateStore(config.statePath);
  await store.load();

  const agent = new GrookieAgent(config, store);
  await agent.initialize();

  const discord = new DiscordController(config, agent, store);
  await discord.start();

  // Last line of a successful boot. deploy/restart.sh watches the log for this and
  // rolls the previous build back if it never appears.
  console.log(formatReadiness(readiness(config.model)));

  const signal = await waitForShutdownSignal();
  console.log(`shutting down on ${signal}`);
  await discord.stop();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
