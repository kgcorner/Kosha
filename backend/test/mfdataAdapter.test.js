import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MfdataAdapter } from "../src/scrapers/mfdataAdapter.js";
import { createSourceRegistry } from "../src/scrapers/sourceRegistry.js";
import { normalizeCategories } from "../src/scrapers/categoryList.js";

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    json: async () => body
  };
}

// Route fetch calls by URL prefix; records every requested URL.
function mockFetch(routes) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    for (const [prefix, handler] of routes) {
      if (url.startsWith(prefix)) return typeof handler === "function" ? handler(url, calls) : handler;
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, calls };
}

const noSleep = async () => {};
const CONFIG = { mfdata: { request_delay_ms: 0, retry_backoff_ms: 0 } };

test("mfdata adapter supports only mfdata.in URLs", () => {
  const adapter = new MfdataAdapter("https://mfdata.in/");
  assert.equal(adapter.supports("https://mfdata.in/api/v1/families/87/holdings"), true);
  assert.equal(adapter.supports("https://groww.in/mutual-funds/x"), false);
  assert.equal(adapter.supports("not a URL"), false);
});

test("discoverFunds collapses plan variants to one entry per family and drops index funds", async () => {
  const categoryUrl = "https://mfdata.in/api/v1/schemes?category=Small%20Cap&plan_type=direct";
  const { fetch } = mockFetch([[categoryUrl, jsonResponse({
    status: "success",
    data: [
      { scheme_code: 1, scheme_name: "Quant Small Cap Fund - Direct Plan - Growth", family_id: 10, family_name: "Quant Small Cap Fund", category: "Small Cap" },
      { scheme_code: 2, scheme_name: "Quant Small Cap Fund - Direct Plan - IDCW", family_id: 10, family_name: "Quant Small Cap Fund", category: "Small Cap" },
      { scheme_code: 3, scheme_name: "SBI Small Cap Fund - Direct Plan - Growth", family_id: 20, category: "Small Cap" },
      { scheme_code: 4, scheme_name: "Motilal Oswal Nifty Smallcap 250 Index Fund - Direct", family_id: 30, family_name: "Motilal Oswal Nifty Smallcap 250 Index Fund" },
      { scheme_code: 5, scheme_name: "Orphan variant" }
    ]
  })]]);
  const adapter = new MfdataAdapter("https://mfdata.in/", { fetch, sleep: noSleep });

  const funds = await adapter.discoverFunds(null, { ...CONFIG, category_url: categoryUrl });

  assert.deepEqual(funds, [
    { name: "Quant Small Cap Fund", url: "https://mfdata.in/api/v1/families/10/holdings" },
    { name: "SBI Small Cap Fund", url: "https://mfdata.in/api/v1/families/20/holdings" }
  ]);
});

test("discoverFunds follows pagination via next links and page counters", async () => {
  // URLSearchParams re-serialises spaces as "+", so use that form for the routes.
  const base = "https://mfdata.in/api/v1/schemes?category=Mid+Cap";
  const { fetch, calls } = mockFetch([
    [`${base}&page=2`, jsonResponse({ data: { items: [{ family_id: 2, family_name: "B Mid Cap Fund" }], page: 2, total_pages: 2 } })],
    [base, jsonResponse({ data: { items: [{ family_id: 1, family_name: "A Mid Cap Fund" }] }, pagination: { page: 1, total_pages: 2 } })]
  ]);
  const adapter = new MfdataAdapter("https://mfdata.in/", { fetch, sleep: noSleep });

  const funds = await adapter.discoverFunds(null, { ...CONFIG, category_url: base });

  assert.deepEqual(funds.map((fund) => fund.name), ["A Mid Cap Fund", "B Mid Cap Fund"]);
  assert.equal(calls.length, 2);
});

test("scrapeFundHoldings maps equity rows, adds holding_type/month params, and leaves url null", async () => {
  const { fetch, calls } = mockFetch([["https://mfdata.in/api/v1/families/87/holdings", jsonResponse({
    status: "success",
    data: {
      family_id: 87,
      month: "2026-09",
      equity: [
        { name: "  Multi Commodity Exchange Of India Ltd. ", isin: "INE745G01035", sector: "Financial Services", weight_pct: "3.21", quantity: 1200000, market_value: 1450.5, mom_change: 5000 },
        { stock_name: "Karur Vysya Bank Ltd.", sector: "Banks", weight: 2.4 },
        { name: "" }
      ]
    }
  })]]);
  const adapter = new MfdataAdapter("https://mfdata.in/", { fetch, sleep: noSleep });

  const holdings = await adapter.scrapeFundHoldings(
    null,
    "https://mfdata.in/api/v1/families/87/holdings",
    { mfdata: { ...CONFIG.mfdata, month: "2026-09" } }
  );

  const requested = new URL(calls[0]);
  assert.equal(requested.searchParams.get("holding_type"), "equity");
  assert.equal(requested.searchParams.get("month"), "2026-09");
  assert.equal(holdings.length, 2);
  assert.deepEqual(holdings[0], {
    name: "Multi Commodity Exchange Of India Ltd.",
    sector: "Financial Services",
    instrument: "Equity",
    weightPercentage: 3.21,
    url: null,
    isin: "INE745G01035",
    quantity: 1200000,
    marketValue: 1450.5,
    monthChange: 5000,
    month: "2026-09"
  });
  assert.equal(holdings[1].name, "Karur Vysya Bank Ltd.");
  assert.equal(holdings[1].weightPercentage, 2.4);
});

test("scrapeFundHoldings accepts the equity_holdings and mixed-holdings envelopes", async () => {
  const { fetch } = mockFetch([
    ["https://mfdata.in/api/v1/families/1/", jsonResponse({ equity_holdings: [{ name: "A Ltd", weight_percentage: 1 }] })],
    ["https://mfdata.in/api/v1/families/2/", jsonResponse({ data: { holdings: [
      { name: "B Ltd", holding_type: "Equity", weight: 2 },
      { name: "GOI 2033", holding_type: "Debt", weight: 5 }
    ] } })]
  ]);
  const adapter = new MfdataAdapter("https://mfdata.in/", { fetch, sleep: noSleep });

  const first = await adapter.scrapeFundHoldings(null, "https://mfdata.in/api/v1/families/1/holdings", CONFIG);
  const second = await adapter.scrapeFundHoldings(null, "https://mfdata.in/api/v1/families/2/holdings", CONFIG);

  assert.deepEqual(first.map((h) => h.name), ["A Ltd"]);
  assert.deepEqual(second.map((h) => h.name), ["B Ltd"]);
});

test("getJson retries a 429 using Retry-After and fails loudly on other errors", async () => {
  let attempts = 0;
  const waits = [];
  const { fetch } = mockFetch([
    ["https://mfdata.in/api/v1/families/5/", () => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse({}, { status: 429, headers: { "Retry-After": "3" } })
        : jsonResponse({ data: { equity: [{ name: "X Ltd", weight: 1 }] } });
    }],
    ["https://mfdata.in/api/v1/families/6/", jsonResponse({ error: "nope" }, { status: 404 })]
  ]);
  const adapter = new MfdataAdapter("https://mfdata.in/", { fetch, sleep: async (ms) => waits.push(ms) });

  const holdings = await adapter.scrapeFundHoldings(null, "https://mfdata.in/api/v1/families/5/holdings", CONFIG);
  assert.equal(holdings.length, 1);
  assert.deepEqual(waits, [3000]);

  await assert.rejects(
    adapter.scrapeFundHoldings(null, "https://mfdata.in/api/v1/families/6/holdings", CONFIG),
    /HTTP 404/
  );
});

test("scraping.mfdata.json selects the mfdata source and every category resolves", async () => {
  const configuration = JSON.parse(
    await readFile(new URL("../config/scraping.mfdata.json", import.meta.url), "utf8")
  );
  assert.equal(configuration.source, "mfdata");
  const registry = createSourceRegistry(configuration);
  for (const category of normalizeCategories(configuration)) {
    assert.ok(registry.resolve(category.url) instanceof MfdataAdapter, category.name);
  }
});
