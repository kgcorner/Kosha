import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import { createApp } from "../src/app.js";
import { TapetideClient, TapetideError, parseRpcMessage } from "../src/services/tapetideClient.js";
import { FundamentalsService, DEFAULT_SECTIONS } from "../src/services/fundamentalsService.js";

// ---------- TapetideClient ----------

function httpResponse(body, { status = 200, headers = {}, raw = false } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const text = raw ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text)
  };
}

function rpcResult(payload, { isError = false } = {}) {
  return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError } };
}

test("client exchanges the refresh token once and calls tools with a bearer token", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/token")) return httpResponse({ access_token: "acc-1", expires_in: 3600 });
    const body = JSON.parse(init.body);
    return httpResponse(rpcResult({ tool: body.params.name, args: body.params.arguments }));
  };
  const client = new TapetideClient({ token: "tpt_rt_x", fetch });

  const first = await client.callTool("get_stock_quote", { symbol: "TCS" });
  await client.callTool("get_stock_quote", { symbol: "INFY" });

  assert.deepEqual(first, { tool: "get_stock_quote", args: { symbol: "TCS" } });
  assert.equal(calls.filter((c) => c.url.endsWith("/token")).length, 1);
  const tokenBody = new URLSearchParams(calls[0].init.body);
  assert.equal(tokenBody.get("grant_type"), "refresh_token");
  assert.equal(tokenBody.get("refresh_token"), "tpt_rt_x");
  assert.equal(calls[1].init.headers.Authorization, "Bearer acc-1");
});

test("client parses SSE responses and retries once after a 401", async () => {
  let tokens = 0;
  let mcpCalls = 0;
  const fetch = async (url) => {
    if (url.endsWith("/token")) return httpResponse({ access_token: `acc-${++tokens}`, expires_in: 3600 });
    mcpCalls += 1;
    if (mcpCalls === 1) return httpResponse("expired", { status: 401, raw: true });
    return httpResponse(`event: message\ndata: ${JSON.stringify(rpcResult({ ok: true }))}\n\n`, { raw: true });
  };
  const client = new TapetideClient({ token: "t", fetch });
  assert.deepEqual(await client.callTool("x"), { ok: true });
  assert.equal(tokens, 2);
});

test("client surfaces quota, tool errors and missing token as TapetideError", async () => {
  const quota = new TapetideClient({
    token: "t",
    fetch: async (url) => url.endsWith("/token")
      ? httpResponse({ access_token: "a" })
      : httpResponse("", { status: 429, headers: { "Retry-After": "120" }, raw: true })
  });
  await assert.rejects(quota.callTool("x"), (error) => error.code === "rate_limited" && error.retryAfterSeconds === 120);

  const toolError = new TapetideClient({
    token: "t",
    fetch: async (url) => url.endsWith("/token")
      ? httpResponse({ access_token: "a" })
      : httpResponse(rpcResult({ error: "Unknown symbol" }, { isError: true }))
  });
  await assert.rejects(toolError.callTool("x"), (error) => error.code === "tool_error" && /Unknown symbol/.test(error.message));

  await assert.rejects(new TapetideClient({}).callTool("x"), (error) => error.code === "not_configured");

  const offline = new TapetideClient({
    token: "t",
    fetch: async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    }
  });
  await assert.rejects(
    offline.callTool("x"),
    (error) => error.code === "unreachable" && /Could not reach Tapetide at https:\/\/mcp\.tapetide\.com: fetch failed \(ENOTFOUND\)/.test(error.message)
  );
  assert.equal(parseRpcMessage("garbage"), null);
});

// ---------- FundamentalsService ----------

function fakeClient(handlers) {
  const calls = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected tool ${name}`);
      return typeof handler === "function" ? handler(args, calls) : handler;
    }
  };
}

const HANDLERS = {
  search_stocks: { results: [{ symbol: "KARURVYSYA", name: "Karur Vysya Bank", isin: "INE036D01028" }] },
  get_company_profile: (args) => ({ symbol: args.symbol, pe: 9.8, roe: 17.2 }),
  get_financials: { quarterly: [{ period: "Sep 2026", revenue: 1 }] },
  get_shareholding: (args) => ({ type: args.type, promoter: 2.1 }),
  get_promoter_pledge: { pledged_pct: 0 }
};

function setup({ handlers = HANDLERS, now = () => Date.now() } = {}) {
  const db = createDatabase(":memory:");
  const repositories = createRepositories(db);
  const stockId = repositories.holdings.upsertStock({ name: "Karur Vysya Bank Ltd.", isin: "INE036D01028" });
  const client = fakeClient(handlers);
  const service = new FundamentalsService({ repositories, client, now });
  return { db, repositories, stockId, client, service };
}

test("first request resolves the symbol by ISIN, fetches every section and caches it", async () => {
  const { db, repositories, stockId, client, service } = setup();
  try {
    const result = await service.getFundamentals(stockId);
    assert.equal(result.stock.symbol, "KARURVYSYA");
    assert.deepEqual(client.calls[0], { name: "search_stocks", args: { query: "INE036D01028", limit: 5 } });
    assert.deepEqual(Object.keys(result.fundamentals), Object.keys(DEFAULT_SECTIONS));
    assert.deepEqual(result.fundamentals.profile.data, { symbol: "KARURVYSYA", pe: 9.8, roe: 17.2 });
    assert.equal(result.fundamentals.shareholding.data.type, "quarterly");
    assert.equal(result.fundamentals.profile.cached, false);
    assert.deepEqual(result.errors, []);
    assert.equal(repositories.stocks.getById(stockId).symbol, "KARURVYSYA");

    const callsAfterFirst = client.calls.length;
    const again = await service.getFundamentals(stockId);
    assert.equal(client.calls.length, callsAfterFirst, "fresh cache must not call the provider");
    assert.equal(again.fundamentals.financials.cached, true);
  } finally {
    db.close();
  }
});

test("the provider is called at most once per stock per section per calendar day (IST)", async () => {
  // Rows are stamped by SQLite with the real time; freshness is driven by
  // moving the service's clock forward a day.
  let clock = Date.now();
  const { db, client, stockId, service, repositories } = setup({ now: () => clock });
  try {
    await service.getFundamentals(stockId);
    const afterFirst = client.calls.length;

    // Same day, many views: no external calls, everything served from SQLite.
    for (let i = 0; i < 3; i += 1) {
      const again = await service.getFundamentals(stockId);
      assert.equal(again.fundamentals.profile.cached, true);
    }
    assert.equal(client.calls.length, afterFirst);

    // Next calendar day: every section is fetched once more (symbol stays cached).
    clock += 24 * 60 * 60 * 1000;
    const nextDay = await service.getFundamentals(stockId);
    assert.deepEqual(
      client.calls.slice(afterFirst).map((c) => c.name),
      ["get_company_profile", "get_financials", "get_shareholding", "get_promoter_pledge"]
    );
    assert.equal(nextDay.fundamentals.financials.cached, false);
    assert.equal(nextDay.cache_policy.timezone, "Asia/Kolkata");

    // Day boundary is the configured timezone's midnight, not UTC's.
    const ist = new FundamentalsService({ repositories, client, timezone: "Asia/Kolkata", now: () => Date.parse("2026-10-28T18:40:00Z") });
    assert.equal(ist.fetchedToday({ fetched_at: "2026-10-28 18:35:00" }), true);   // both 29 Oct IST
    assert.equal(ist.fetchedToday({ fetched_at: "2026-10-28 18:20:00" }), false);  // 23:50 on 28 Oct IST
    const utc = new FundamentalsService({ repositories, client, timezone: "UTC", now: () => Date.parse("2026-10-28T18:40:00Z") });
    assert.equal(utc.fetchedToday({ fetched_at: "2026-10-28 18:20:00" }), true);
  } finally {
    db.close();
  }
});

test("quota errors fall back to stale cached data and stop further calls", async () => {
  let clock = Date.now();
  let quotaExhausted = false;
  const handlers = {
    ...HANDLERS,
    get_company_profile: (args) => {
      if (quotaExhausted) throw new TapetideError("quota", { code: "rate_limited", retryAfterSeconds: 60 });
      return { symbol: args.symbol, pe: 9.8 };
    }
  };
  const { db, stockId, client, service } = setup({ handlers, now: () => clock });
  try {
    await service.getFundamentals(stockId);
    clock += 24 * 60 * 60 * 1000; // next day: everything is due again
    quotaExhausted = true;
    const before = client.calls.length;
    const result = await service.getFundamentals(stockId);

    assert.equal(client.calls.length - before, 1, "stops after the first quota error");
    assert.equal(result.errors[0].code, "rate_limited");
    assert.equal(result.errors[0].retry_after_seconds, 60);
    assert.equal(result.fundamentals.profile.stale, true);
    assert.equal(result.fundamentals.pledge.stale, true);
    assert.deepEqual(result.fundamentals.profile.data, { symbol: "KARURVYSYA", pe: 9.8 });
  } finally {
    db.close();
  }
});

test("unknown symbols report one error without burning quota on every section", async () => {
  const { db, stockId, client, service } = setup({ handlers: { ...HANDLERS, search_stocks: { results: [] } } });
  try {
    const result = await service.getFundamentals(stockId);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, "symbol_not_found");
    assert.deepEqual(client.calls.map((c) => c.name), ["search_stocks", "search_stocks"]); // ISIN, then name
    assert.deepEqual(result.fundamentals, {});
  } finally {
    db.close();
  }
});

test("fund signal reports overall and per-category consensus", async () => {
  const { db, repositories, stockId, service } = setup();
  try {
    const a = repositories.funds.upsert({ name: "A Small Cap", url: "u://a", category: "Small Cap" });
    const b = repositories.funds.upsert({ name: "B Small Cap", url: "u://b", category: "Small Cap" });
    repositories.funds.upsert({ name: "C Small Cap", url: "u://c", category: "Small Cap" });
    repositories.holdings.replaceFundHoldings(a.id, [{ name: "Karur Vysya Bank Ltd.", isin: "INE036D01028", weightPercentage: 2 }]);
    repositories.holdings.replaceFundHoldings(b.id, [{ name: "KARUR VYSYA BANK LIMITED", isin: "INE036D01028", weightPercentage: 3 }]);
    repositories.aggregation.recompute();

    const { fund_signal: signal } = await service.getFundamentals(stockId, { sections: ["pledge"] });
    assert.equal(signal.funds_holding, 2);
    assert.deepEqual(signal.categories, [{ category: "Small Cap", funds_holding: 2, funds_in_category: 3, weight_avg: 2.5 }]);
  } finally {
    db.close();
  }
});

// ---------- HTTP route ----------

async function withServer(dependencies, run) {
  const server = createApp(dependencies).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET /api/stocks/:id/fundamentals serves data, 404s unknown stocks, 400s bad sections, 503s when unconfigured", async () => {
  const { db, repositories, stockId, service } = setup();
  try {
    await withServer({ repositories, fundamentalsService: service }, async (base) => {
      const ok = await fetch(`${base}/api/stocks/${stockId}/fundamentals?sections=profile,pledge`);
      assert.equal((await fetch(`${base}/api/stocks/${stockId}/fundamentals?sections=profile`)).status, 200);
      assert.equal(ok.status, 200);
      const body = await ok.json();
      assert.deepEqual(Object.keys(body.fundamentals), ["profile", "pledge"]);
      assert.equal(body.stock.isin, "INE036D01028");

      assert.equal((await fetch(`${base}/api/stocks/99999/fundamentals`)).status, 404);
      assert.equal((await fetch(`${base}/api/stocks/abc/fundamentals`)).status, 404);
      const bad = await fetch(`${base}/api/stocks/${stockId}/fundamentals?sections=nope`);
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /Unknown fundamentals section/);
    });
    await withServer({ repositories }, async (base) => {
      assert.equal((await fetch(`${base}/api/stocks/${stockId}/fundamentals`)).status, 503);
    });
  } finally {
    db.close();
  }
});
