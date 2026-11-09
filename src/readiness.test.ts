import assert from "node:assert/strict";
import { test } from "node:test";

import { formatReadiness, readSha, readVersion, readiness } from "./readiness.js";

test("readiness is one greppable line of key=value fields", () => {
  const line = formatReadiness({
    pid: 4242,
    version: "0.1.0",
    sha: "6d8a063",
    model: "local/qwen",
    timestamp: "2026-09-08T07:30:46.990Z",
  });

  assert.equal(line.includes("\n"), false);
  assert.match(
    line,
    /^ready pid=4242 version=0\.1\.0 sha=6d8a063 model=local\/qwen ts=2026-09-08T07:30:46\.990Z$/,
  );
});

test("version comes from package.json", () => {
  assert.match(readVersion(), /^\d+\.\d+\.\d+/);
});

test("sha is a short hex string, or unknown outside a checkout", () => {
  assert.match(readSha(), /^([0-9a-f]{7,40}|unknown)$/);
});

test("readiness stamps the current process and clock", () => {
  const info = readiness("some/model");
  assert.equal(info.pid, process.pid);
  assert.equal(info.model, "some/model");
  assert.match(info.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});
