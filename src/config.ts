import { resolve } from "node:path";

export interface Config {
  discordToken: string;
  allowedRoleIds: Set<string>;
  statePath: string;
  model: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function idSet(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function requiredIdSet(name: string): Set<string> {
  const values = idSet(name);
  if (values.size === 0) {
    throw new Error(`${name} must contain at least one Discord ID`);
  }
  return values;
}

export function loadConfig(): Config {
  return {
    discordToken: required("DISCORD_TOKEN"),
    allowedRoleIds: requiredIdSet("GROOKIE_ALLOWED_ROLE_IDS"),
    statePath: resolve(process.env.GROOKIE_STATE_PATH ?? "state/grookie.json"),
    model: required("GROOKIE_MODEL"),
  };
}
