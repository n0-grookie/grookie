import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Everything a supervisor (or Grookie's restart script) needs to tell *which* build
 * answered and *when*. Printed once, on one line, after the Discord session is up.
 */
export interface Readiness {
  readonly pid: number;
  readonly version: string;
  readonly sha: string;
  readonly model: string;
  readonly timestamp: string;
}

/** Repo root: this module lives in dist/ or src/, both one level below it. */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function readVersion(root: string = repoRoot()): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const version =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;
    if (typeof version === "string" && version.length > 0) return version;
  } catch {
    // No readable package.json: report unknown rather than failing the boot.
  }
  return "unknown";
}

export function readSha(root: string = repoRoot()): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (sha.length > 0) return sha;
  } catch {
    // Not a checkout (or no git on PATH): still boot, just unverifiable.
  }
  return "unknown";
}

export function readiness(model: string): Readiness {
  return {
    pid: process.pid,
    version: readVersion(),
    sha: readSha(),
    model,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Single line, `key=value` fields, always starting with `ready `. deploy/restart.sh
 * greps for exactly this to decide whether a new build survived or needs rolling back.
 */
export function formatReadiness(info: Readiness): string {
  return (
    `ready pid=${info.pid} version=${info.version} sha=${info.sha} ` +
    `model=${info.model} ts=${info.timestamp}`
  );
}
