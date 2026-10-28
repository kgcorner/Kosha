import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile, parseEnv } from "../src/env.js";

test("parseEnv handles comments, export, quotes, spaces and Windows line endings", () => {
  const parsed = parseEnv(
    [
      "﻿# comment",
      "TAPETIDE_TOKEN=tpt_rt_abc123",
      "export OPENROUTER_API_KEY = sk-or-v1-xyz # trailing comment",
      'QUOTED="has # hash and spaces"',
      "SINGLE='x=y'",
      "EMPTY=",
      "not a valid line",
      "WIN=crlf\r"
    ].join("\n")
  );
  assert.deepEqual(parsed, {
    TAPETIDE_TOKEN: "tpt_rt_abc123",
    OPENROUTER_API_KEY: "sk-or-v1-xyz",
    QUOTED: "has # hash and spaces",
    SINGLE: "x=y",
    EMPTY: "",
    WIN: "crlf"
  });
});

test("loadEnvFile fills missing variables, keeps ones already set, and tolerates a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "kosha-env-"));
  try {
    const file = join(dir, ".env");
    writeFileSync(file, "TAPETIDE_TOKEN=from_file\nOPENROUTER_API_KEY=from_file\n");
    const env = { OPENROUTER_API_KEY: "from_shell" };
    const result = loadEnvFile(file, env);
    assert.deepEqual(env, { TAPETIDE_TOKEN: "from_file", OPENROUTER_API_KEY: "from_shell" });
    assert.deepEqual(result.loaded, ["TAPETIDE_TOKEN"]);
    assert.deepEqual(result.skipped, ["OPENROUTER_API_KEY"]);

    assert.equal(loadEnvFile(join(dir, "missing.env"), {}).found, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
