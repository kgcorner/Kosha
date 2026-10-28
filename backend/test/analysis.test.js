import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import { createApp } from "../src/app.js";
import { OpenAICompatibleProvider, createLlmProvider, parseJsonText } from "../src/services/llmProviders.js";
import { StockAnalysisService, buildDigest, validateAnalysis } from "../src/services/stockAnalysisService.js";
import { OllamaService } from "../src/services/ollamaService.js";

const GOOD = {
  verdict: "BUY",
  confidence: "medium",
  summary: "Broad fund backing and reasonable valuation.",
  fund_consensus: "Held by 22 of 36 small-cap funds.",
  valuation: "P/E below industry.",
  strengths: ["Low debt"],
  risks: ["Small-cap volatility"],
  red_flags: [],
  what_would_change_view: ["Funds start exiting"],
  data_gaps: []
};

function chatResponse(content, status = 200) {
  const body = status === 200 ? { choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] } : content;
  return {
    status,
    ok: status === 200,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body))
  };
}

// ---------- provider ----------

test("OpenRouter provider sends schema-constrained chat request with auth and attribution headers", async () => {
  const requests = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://openrouter.ai/api/v1/",
    model: "google/gemini-2.5-flash",
    apiKey: "sk-or-x",
    fetch: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return chatResponse(GOOD);
    }
  });

  const result = await provider.generateJson({ system: "sys", prompt: "data", schema: { type: "object" }, schemaName: "s" });
  assert.deepEqual(result, GOOD);
  assert.equal(requests[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(requests[0].init.headers.authorization, "Bearer sk-or-x");
  assert.equal(requests[0].init.headers["X-Title"], "Kosha");
  assert.equal(requests[0].body.response_format.type, "json_schema");
  assert.equal(requests[0].body.messages[0].content, "sys");
  assert.deepEqual(provider.describe(), { provider: "openrouter", model: "google/gemini-2.5-flash" });
});

test("provider falls back from json_schema to json_object to plain on 400 and remembers it", async () => {
  const formats = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      formats.push(body.response_format?.type ?? "none");
      if (body.response_format) return chatResponse({ error: "response_format unsupported" }, 400);
      return chatResponse("Sure! ```json\n" + JSON.stringify(GOOD) + "\n```");
    }
  });

  assert.deepEqual(await provider.generateJson({ system: "s", prompt: "p", schema: { type: "object" } }), GOOD);
  assert.deepEqual(formats, ["json_schema", "json_object", "none"]);
  assert.equal(provider.configured, true, "local servers need no key");

  formats.length = 0;
  await provider.generateJson({ system: "s", prompt: "p", schema: { type: "object" } });
  assert.deepEqual(formats, ["json_object", "none"], "json_schema is skipped once rejected");
});

test("provider reports missing key, auth failure and rate limits with codes", async () => {
  const noKey = new OpenAICompatibleProvider({ baseUrl: "https://openrouter.ai/api/v1", model: "m" });
  assert.equal(noKey.configured, false);
  await assert.rejects(noKey.generateJson({ system: "s", prompt: "p" }), (e) => e.code === "not_configured");

  const unauthorized = new OpenAICompatibleProvider({ model: "m", apiKey: "k", fetch: async () => chatResponse({ error: "bad key" }, 401) });
  await assert.rejects(unauthorized.generateJson({ system: "s", prompt: "p" }), (e) => e.code === "not_configured");

  const limited = new OpenAICompatibleProvider({ model: "m", apiKey: "k", fetch: async () => chatResponse({ error: "slow down" }, 429) });
  await assert.rejects(limited.generateJson({ system: "s", prompt: "p" }), (e) => e.code === "rate_limited");
});

test("createLlmProvider reads the key from the configured env var and rejects unknown providers", () => {
  const provider = createLlmProvider(
    { provider: "openai-compatible", base_url: "https://openrouter.ai/api/v1", api_key_env: "OPENROUTER_API_KEY", model: "x/y" },
    { OPENROUTER_API_KEY: "sk-or-1" }
  );
  assert.equal(provider.apiKey, "sk-or-1");
  assert.equal(provider.configured, true);
  assert.throws(() => createLlmProvider({ provider: "gemini" }), /Unknown llm.provider/);
});

test("parseJsonText extracts JSON from fenced or chatty output", () => {
  assert.deepEqual(parseJsonText('Here you go: {"a":1} hope it helps'), { a: 1 });
  assert.throws(() => parseJsonText("no json here"), /invalid JSON/);
  assert.throws(() => parseJsonText(""), /empty response/);
});

// ---------- analysis service ----------

function fakeLlm(responses) {
  const calls = [];
  return {
    calls,
    describe: () => ({ provider: "openrouter", model: "test-model" }),
    async generateJson(request) {
      calls.push(request);
      const next = responses.length > 1 ? responses.shift() : responses[0];
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(request) : next;
    }
  };
}

function setup({ llmResponses = [GOOD], fundamentals } = {}) {
  const db = createDatabase(":memory:");
  const repositories = createRepositories(db);
  const fund = repositories.funds.upsert({ name: "A Small Cap", url: "u://a", category: "Small Cap" });
  repositories.holdings.replaceFundHoldings(fund.id, [{ name: "Karur Vysya Bank Ltd.", isin: "INE036D01028", weightPercentage: 2 }]);
  repositories.aggregation.recompute();
  const stockId = repositories.stocks.getById(1).id;
  let fundamentalsResult = fundamentals ?? {
    stock: { id: stockId, symbol: "KARURVYSYA" },
    fund_signal: repositories.aggregation.signalFor(stockId),
    fundamentals: {
      profile: { data: { pe: 9.8, industry_pe: 14.1, roe: 17.2, notes: null }, fetched_at: "2026-10-27 10:00:00", cached: true, stale: false },
      pledge: { data: { pledged_pct: 0 }, fetched_at: "2026-10-01 10:00:00", cached: true, stale: true }
    },
    errors: []
  };
  const fundamentalsService = {
    calls: 0,
    async getFundamentals() {
      this.calls += 1;
      return fundamentalsResult;
    }
  };
  const llm = fakeLlm(llmResponses);
  const service = new StockAnalysisService({ repositories, fundamentalsService, llm });
  return {
    db, repositories, stockId, llm, service, fundamentalsService,
    setFundamentals: (value) => { fundamentalsResult = value; }
  };
}

test("analysis feeds fund signal + fundamentals to the LLM and is stored", async () => {
  const { db, stockId, llm, service } = setup();
  try {
    const first = await service.analyze(stockId);
    assert.equal(first.analysis.verdict, "BUY");
    assert.equal(first.cached, false);
    assert.equal(first.model.model, "test-model");
    assert.deepEqual(first.inputs.stale_sections, ["pledge"]);
    assert.match(first.disclaimer, /Not investment advice/);

    const prompt = llm.calls[0].prompt;
    assert.match(prompt, /does NOT hold/);
    assert.match(prompt, /Allowed verdicts: BUY, IGNORE/);
    const data = JSON.parse(prompt.slice(prompt.indexOf("{")));
    assert.equal(data.fund_signal.funds_holding, 1);
    assert.equal(data.fundamentals.profile.data.pe, 9.8);
    assert.equal("notes" in data.fundamentals.profile.data, false, "nulls are pruned");
    assert.deepEqual(llm.calls[0].schema.properties.verdict.enum, ["BUY", "IGNORE"]);

    const second = await service.analyze(stockId);
    assert.equal(second.cached, true);
    assert.equal(llm.calls.length, 1, "the stored analysis is reused");
  } finally {
    db.close();
  }
});

test("the model is called at most once per day; later days only when the data changed", async () => {
  const DAY = 24 * 60 * 60 * 1000;
  let clock = Date.now();
  const { db, stockId, llm, service, setFundamentals } = setup();
  service.now = () => clock;
  const profile = (pe, fetchedAt) => ({
    stock: { id: stockId, symbol: "KARURVYSYA" },
    fund_signal: { funds_holding: 1, rank: 1, categories: [] },
    fundamentals: { profile: { data: { pe }, fetched_at: fetchedAt, cached: false, stale: false } },
    errors: []
  });
  try {
    setFundamentals(profile(9.8, "2026-10-28 04:00:00"));
    await service.analyze(stockId);
    assert.equal(llm.calls.length, 1);

    // Same day, the numbers change: still the stored answer (once per day).
    setFundamentals(profile(11, "2026-10-28 09:00:00"));
    assert.equal((await service.analyze(stockId)).cached, true);
    assert.equal(llm.calls.length, 1);

    // Next day, same numbers re-fetched (only the timestamp differs): no call.
    clock += DAY;
    setFundamentals(profile(9.8, "2026-10-29 04:00:00"));
    db.prepare("UPDATE stock_analyses SET created_at = datetime(created_at, '-1 day')").run();
    assert.equal((await service.analyze(stockId)).cached, true);
    assert.equal(llm.calls.length, 1, "unchanged content is not re-analysed");

    // Next day with different numbers: one new call.
    setFundamentals(profile(12.5, "2026-10-29 05:00:00"));
    assert.equal((await service.analyze(stockId)).cached, false);
    assert.equal(llm.calls.length, 2);
  } finally {
    db.close();
  }
});

test("a same-day analysis made while data was missing is redone once the data arrives", async () => {
  const { db, stockId, llm, service, setFundamentals } = setup();
  try {
    setFundamentals({
      stock: { id: stockId, symbol: null },
      fund_signal: { funds_holding: 1, rank: 1, categories: [] },
      fundamentals: {},
      errors: [{ section: "profile", code: "rate_limited", message: "quota" }]
    });
    await service.analyze(stockId);
    setFundamentals({
      stock: { id: stockId, symbol: "KARURVYSYA" },
      fund_signal: { funds_holding: 1, rank: 1, categories: [] },
      fundamentals: { profile: { data: { pe: 9.8 }, fetched_at: "2026-10-28 10:00:00", cached: false, stale: false } },
      errors: []
    });
    const redone = await service.analyze(stockId);
    assert.equal(redone.cached, false);
    assert.equal(llm.calls.length, 2);
    assert.equal((await service.analyze(stockId)).cached, true);
    assert.equal(llm.calls.length, 2);
  } finally {
    db.close();
  }
});

test("chat prompt contains role, situation, every data section and the opening ask, without calling the model", async () => {
  const { db, stockId, llm, service } = setup();
  try {
    const result = await service.chatPrompt(stockId, { held: true });
    const text = result.prompt;
    assert.equal(llm.calls.length, 0);
    assert.match(text, /^# Stock decision session: Karur Vysya Bank Ltd\. \(NSE: KARURVYSYA, ISIN INE036D01028\)/);
    assert.match(text, /## Your role and rules/);
    assert.match(text, /I ALREADY HOLD this stock/);
    assert.match(text, /### Fund signal[\s\S]*"funds_holding": 1/);
    assert.match(text, /### Company profile[\s\S]*"pe": 9\.8/);
    assert.match(text, /could not be refreshed today[^\n]*pledge/);
    assert.match(text, /Not available for this session: Financial statements/);
    assert.match(text, /Start with your verdict \(HOLD or SELL\)/);
    assert.match(text, /wait for my follow-up questions/);
    assert.equal(result.chars, text.length);
    assert.ok(result.approx_tokens > 0);
    assert.deepEqual(result.sections, ["profile", "pledge"]);
    assert.equal(await service.chatPrompt(99999), null);
  } finally {
    db.close();
  }
});

test("held=true asks for HOLD/SELL and is cached separately", async () => {
  const { db, stockId, llm, service } = setup({ llmResponses: [{ ...GOOD, verdict: "sell" }] });
  try {
    const result = await service.analyze(stockId, { held: true });
    assert.equal(result.analysis.verdict, "SELL");
    assert.equal(result.held, true);
    assert.match(llm.calls[0].prompt, /ALREADY HOLDS/);
    assert.deepEqual(llm.calls[0].schema.properties.verdict.enum, ["HOLD", "SELL"]);
  } finally {
    db.close();
  }
});

test("an out-of-set verdict is rejected rather than stored", async () => {
  const { db, repositories, stockId, service } = setup({ llmResponses: [{ ...GOOD, verdict: "HOLD" }] });
  try {
    await assert.rejects(service.analyze(stockId), /expected one of BUY\/IGNORE/);
    assert.equal(repositories.analyses.get(stockId, false), null);
  } finally {
    db.close();
  }
});

test("validateAnalysis normalises confidence and trims lists", () => {
  const result = validateAnalysis({ ...GOOD, confidence: "VERY", strengths: [" a ", "", 3] }, ["BUY", "IGNORE"]);
  assert.equal(result.confidence, "low");
  assert.deepEqual(result.strengths, ["a", "3"]);
  assert.throws(() => validateAnalysis({ ...GOOD, summary: " " }, ["BUY", "IGNORE"]), /missing a summary/);
});

test("buildDigest caps oversized sections", () => {
  const big = { quarterly: Array.from({ length: 40 }, (_, i) => ({ period: `Q${i}`, revenue: i, text: "x".repeat(300) })) };
  const digest = buildDigest({
    stock: { name: "X", isin: "I" },
    fundSignal: { funds_holding: 3.14159 },
    fundamentals: { fundamentals: { financials: { data: big, fetched_at: "t" } } },
    maxSectionChars: 2000
  });
  assert.ok(JSON.stringify(digest.fundamentals.financials.data).length <= 2100);
  assert.equal(digest.fund_signal.funds_holding, 3.14);
});

// ---------- scrape-time thesis uses the shared provider ----------

test("OllamaService routes the thesis through the shared provider and no longer says Large Cap", async () => {
  const llm = fakeLlm([{ thesis: "t", pros: ["p"], cons: ["c"] }]);
  const service = new OllamaService({ provider: llm });
  const result = await service.analyze({ name: "X", consensus_score: 5, weight_avg: 1, weight_min: 1, weight_max: 1, metrics: null });
  assert.equal(result.thesis, "t");
  assert.doesNotMatch(llm.calls[0].prompt, /Large Cap/);
});

// ---------- HTTP ----------

test("GET /api/stocks/:id/analysis returns the verdict and maps errors to status codes", async () => {
  const { db, repositories, stockId, service } = setup();
  const server = createApp({ repositories, analysisService: service }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/api/stocks/${stockId}/analysis`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).analysis.verdict, "BUY");
    assert.equal((await fetch(`${base}/api/stocks/999/analysis`)).status, 404);

    service.llm = fakeLlm([Object.assign(new Error("no key"), { code: "not_configured" })]);
    const unconfigured = await fetch(`${base}/api/stocks/${stockId}/analysis?held=true`);
    assert.equal(unconfigured.status, 503);
    assert.equal((await unconfigured.json()).code, "not_configured");

    const prompt = await fetch(`${base}/api/stocks/${stockId}/chat-prompt`);
    assert.equal(prompt.status, 200);
    assert.match((await prompt.json()).prompt, /BUY or IGNORE/);
    const text = await fetch(`${base}/api/stocks/${stockId}/chat-prompt?format=text&held=true`);
    assert.match(text.headers.get("content-type"), /text\/markdown/);
    assert.match(await text.text(), /^# Stock decision session/);
    assert.equal((await fetch(`${base}/api/stocks/999/chat-prompt`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }

  const bare = createApp({ repositories: {} }).listen(0);
  await new Promise((resolve) => bare.once("listening", resolve));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${bare.address().port}/api/stocks/1/analysis`)).status, 503);
  } finally {
    await new Promise((resolve) => bare.close(resolve));
  }
});
