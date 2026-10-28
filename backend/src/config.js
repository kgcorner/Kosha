import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function loadConfig() {
  const app = readJson(path.resolve(backendRoot, process.env.APP_CONFIG ?? "config/app.json"));
  const scraping = readJson(path.resolve(backendRoot, process.env.SCRAPING_CONFIG ?? "config/scraping.json"));

  const hasCategories = Array.isArray(scraping.categories) && scraping.categories.length > 0;
  if (!scraping.source || !scraping.selectors || (!hasCategories && !scraping.category_url)) {
    throw new Error("Scraping configuration must define source, categories (or category_url), and selectors");
  }

  return {
    app: {
      ...app,
      ai: normalizeAiConfig(app),
      port: Number(process.env.PORT ?? app.port),
      database_path: path.resolve(backendRoot, process.env.DATABASE_PATH ?? app.database_path)
    },
    scraping
  };
}

export const AI_DEFAULTS = Object.freeze({
  base_url: "https://openrouter.ai/api/v1",
  api_key_env: "OPENROUTER_API_KEY",
  model: "google/gemini-2.5-flash",
  temperature: 0.2,
  max_output_tokens: 4096,
  timeout_ms: 120000,
  scrape_thesis: { enabled: false, top_stock_limit: 20 }
});

/**
 * One `ai` block configures the OpenAI-compatible LLM used by both the
 * on-demand stock analysis and the optional scrape-time thesis:
 *
 *   "ai": {
 *     "base_url": "https://openrouter.ai/api/v1",   // or http://127.0.0.1:1234/v1 (LM Studio)
 *     "api_key_env": "OPENROUTER_API_KEY",          // env var holding the key; omit for local servers
 *     "model": "google/gemini-2.5-flash",
 *     "scrape_thesis": { "enabled": false, "top_stock_limit": 20 }
 *   }
 *
 * Older configs still load: the legacy `ai` shape (`enabled`, `baseUrl`,
 * `model`, `top_stock_limit`, no `/v1`) and a separate `llm` block are
 * translated here, and a warning explains what to change.
 */
export function normalizeAiConfig(app = {}, warn = console.warn) {
  const legacy = app.ai ?? {};
  const llm = app.llm ?? {};
  const notes = [];

  const baseUrlSource = llm.base_url ?? legacy.base_url ?? legacy.baseUrl;
  let base_url = baseUrlSource ?? AI_DEFAULTS.base_url;
  if (legacy.baseUrl && !legacy.base_url && !llm.base_url) {
    notes.push('"ai.baseUrl" is now "ai.base_url"');
    // OpenAI-compatible servers live under /v1 (LM Studio, Ollama, OpenRouter).
    if (!/\/v\d+\/?$/.test(base_url)) {
      base_url = `${base_url.replace(/\/+$/, "")}/v1`;
      notes.push(`"/v1" was appended to the base URL (${base_url})`);
    }
  }
  if (app.llm) notes.push('the separate "llm" block is merged into "ai"');

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base_url);
  const api_key_env = llm.api_key_env ?? legacy.api_key_env ?? (isLocal ? null : AI_DEFAULTS.api_key_env);

  const legacyThesis = {};
  if (typeof legacy.enabled === "boolean") {
    legacyThesis.enabled = legacy.enabled;
    notes.push('"ai.enabled" is now "ai.scrape_thesis.enabled"');
  }
  if (legacy.top_stock_limit !== undefined) {
    legacyThesis.top_stock_limit = legacy.top_stock_limit;
    notes.push('"ai.top_stock_limit" is now "ai.scrape_thesis.top_stock_limit"');
  }

  const pick = (key) => llm[key] ?? legacy[key] ?? AI_DEFAULTS[key];
  const config = {
    provider: "openai-compatible",
    base_url,
    api_key_env,
    model: pick("model"),
    temperature: pick("temperature"),
    max_output_tokens: pick("max_output_tokens"),
    timeout_ms: pick("timeout_ms"),
    scrape_thesis: { ...AI_DEFAULTS.scrape_thesis, ...legacyThesis, ...(legacy.scrape_thesis ?? {}) }
  };
  if (notes.length > 0 && warn) {
    warn(`[config] Legacy AI settings translated: ${notes.join("; ")}. See config/app.json in the repo for the current "ai" shape.`);
  }
  return config;
}
