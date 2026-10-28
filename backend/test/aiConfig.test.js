import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AI_DEFAULTS, normalizeAiConfig } from "../src/config.js";
import { createLlmProvider } from "../src/services/llmProviders.js";

const quiet = () => {};

test("the shipped config/app.json has the current ai shape and needs no translation", async () => {
  const app = JSON.parse(await readFile(new URL("../config/app.json", import.meta.url), "utf8"));
  assert.equal(app.llm, undefined, "single ai block, no separate llm block");
  const warnings = [];
  const ai = normalizeAiConfig(app, (message) => warnings.push(message));
  assert.deepEqual(warnings, []);
  assert.equal(ai.base_url, "https://openrouter.ai/api/v1");
  assert.equal(ai.api_key_env, "OPENROUTER_API_KEY");
  assert.equal(ai.scrape_thesis.enabled, false);
});

test("the legacy ai block is translated to a working local OpenAI-compatible setup", () => {
  const warnings = [];
  const ai = normalizeAiConfig(
    { ai: { enabled: true, baseUrl: "http://127.0.0.1:1234", model: "ornith-1.5-9b", top_stock_limit: 5 } },
    (message) => warnings.push(message)
  );
  assert.equal(ai.base_url, "http://127.0.0.1:1234/v1");
  assert.equal(ai.api_key_env, null, "local servers need no key");
  assert.equal(ai.model, "ornith-1.5-9b");
  assert.deepEqual(ai.scrape_thesis, { enabled: true, top_stock_limit: 5 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /baseUrl.*base_url/);

  const provider = createLlmProvider(ai, {});
  assert.equal(provider.configured, true);
  assert.deepEqual(provider.describe(), { provider: "local", model: "ornith-1.5-9b" });
});

test("a legacy separate llm block is merged into ai", () => {
  const ai = normalizeAiConfig(
    { ai: { enabled: false }, llm: { base_url: "https://openrouter.ai/api/v1", api_key_env: "MY_KEY", model: "x/y" } },
    quiet
  );
  assert.equal(ai.base_url, "https://openrouter.ai/api/v1");
  assert.equal(ai.api_key_env, "MY_KEY");
  assert.equal(ai.model, "x/y");
  assert.equal(ai.scrape_thesis.enabled, false);
});

test("an empty config falls back to OpenRouter defaults; base URLs already ending in /v1 are kept", () => {
  assert.deepEqual(normalizeAiConfig({}, quiet), { provider: "openai-compatible", ...AI_DEFAULTS, scrape_thesis: { ...AI_DEFAULTS.scrape_thesis } });
  assert.equal(normalizeAiConfig({ ai: { baseUrl: "http://localhost:11434/v1", model: "m" } }, quiet).base_url, "http://localhost:11434/v1");
});
