import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads secrets (TAPETIDE_TOKEN, OPENROUTER_API_KEY, ...) from `backend/.env`
 * into `process.env` at startup, so keys never have to live in config files.
 *
 * - The file is located relative to the backend folder, not the current
 *   directory, so it works however the server is started.
 * - Variables already set in the environment win over the file, so a shell
 *   `export` can still override a value.
 * - `ENV_FILE` points at a different file; a missing file is not an error.
 *
 * Dependency-free on purpose (works on every supported Node version).
 */
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text).replace(/^﻿/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rest] = match;
    let value = rest.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) !== -1) {
      value = value.slice(1, value.indexOf(quote, 1));
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    } else {
      // Unquoted: strip a trailing " # comment".
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[key] = value;
  }
  return values;
}

export function loadEnvFile(filePath, env = process.env) {
  if (!existsSync(filePath)) return { path: filePath, loaded: [], skipped: [], found: false };
  const parsed = parseEnv(readFileSync(filePath, "utf8"));
  const loaded = [];
  const skipped = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined && env[key] !== "") {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    loaded.push(key);
  }
  return { path: filePath, loaded, skipped, found: true };
}

export const ENV_FILE_PATH = path.resolve(backendRoot, process.env.ENV_FILE ?? ".env");

// Side effect on import: server.js imports this module first.
const result = loadEnvFile(ENV_FILE_PATH);
if (result.found) {
  // Names only, never values.
  console.log(
    `[env] ${path.relative(process.cwd(), result.path) || result.path}: loaded ${result.loaded.join(", ") || "nothing"}` +
      (result.skipped.length ? ` (already set in the environment: ${result.skipped.join(", ")})` : "")
  );
}
