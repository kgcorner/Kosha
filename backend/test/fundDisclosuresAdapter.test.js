import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FundDisclosuresAdapter, subCategory } from "../src/scrapers/fundDisclosuresAdapter.js";
import { createSourceRegistry } from "../src/scrapers/sourceRegistry.js";
import { normalizeCategories } from "../src/scrapers/categoryList.js";
import { createDatabase } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";

const HOME = "https://cdn.jsdelivr.net/gh/kushagra-agarwal-a/fund-holdings-data/";
const META_URL = "https://raw.githubusercontent.com/kushagra-agarwal-a/fund-holdings-data/main/meta.json";
const RAW = "https://raw.githubusercontent.com/kushagra-agarwal-a/fund-holdings-data/abc123";
const CDN = "https://cdn.jsdelivr.net/gh/kushagra-agarwal-a/fund-holdings-data@abc123";
const META = {
  commit: "abc123",
  raw_base: RAW,
  cdn_catalog: `${CDN}/catalog/amfi-lookup.json`,
  cdn_asof_template: `${CDN}/portfolios/asof/{as_of}/{portfolio_id}.json`,
  last_asof_sync: { as_of: "2026-09-30" }
};
const SMALL = "Open Ended Schemes ( Equity Scheme - Small Cap Fund )";
const CATALOG = {
  "1": { amfi_code: "1", parent_name: "Alpha Small Cap Fund", portfolio_id: "P1", category: SMALL, latest_as_of: "2026-09-30", available_as_of: ["2026-09-30", "2026-08-31"] },
  "2": { amfi_code: "2", parent_name: "Alpha Small Cap Fund", portfolio_id: "P1", category: SMALL, latest_as_of: "2026-09-30", available_as_of: ["2026-09-30", "2026-08-31"] },
  "3": { amfi_code: "3", parent_name: "Beta Small Cap Fund", portfolio_id: "P2", category: "Open Ended Schemes ( Equity Schemes - Small Cap Fund )", latest_as_of: "2026-09-30", available_as_of: ["2026-09-30"] },
  "4": { amfi_code: "4", parent_name: "Gamma Nifty Smallcap 250 Index Fund", portfolio_id: "P3", category: SMALL, latest_as_of: "2026-09-30", available_as_of: ["2026-09-30"] },
  "5": { amfi_code: "5", parent_name: "Delta Large & Mid Cap Fund", portfolio_id: "P4", category: "Open Ended Schemes ( Equity Scheme - Large & Mid Cap Fund )", latest_as_of: "2026-09-30", available_as_of: ["2026-09-30"] },
  "6": { amfi_code: "6", parent_name: "Epsilon Small Cap Fund", portfolio_id: "P5", category: SMALL, latest_as_of: null, available_as_of: [] }
};
const PORTFOLIO = {
  portfolio_id: "P1",
  meta: { as_of: "2026-09-30" },
  holdings: [
    { holding_type: "equity", instrument: "EQ - NAVIN FLUORINE INTERNATIONAL L", isin: "INE048G01026", industry: "Chemicals", quantity: 1000, market_value: 2500, pct_nav: 1.97 },
    { holding_type: "equity", instrument: "Karur Vysya Bank Ltd.", isin: "INE036D01028", industry: "Banks", quantity: "2,000", market_value: 1200, pct_nav: "1.5" },
    { holding_type: "debt", instrument: "7.1% GOI 2034", isin: "IN0020240019", pct_nav: 3 },
    { holding_type: "cash", instrument: "TREPS", pct_nav: 2 }
  ]
};

function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body };
}

function mockFetch(handler) {
  const calls = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      return handler(url);
    }
  };
}

function defaultHandler(url) {
  if (url === META_URL) return response(META);
  if (url.endsWith("/catalog/amfi-lookup.json")) return response(CATALOG);
  if (url.includes("/portfolios/asof/2026-09-30/P1.json")) return response(PORTFOLIO);
  if (url.includes("/portfolios/asof/2026-08-31/P1.json")) return response({ ...PORTFOLIO, holdings: PORTFOLIO.holdings.slice(1, 2) });
  return response({}, 404);
}

const CONFIG = { fund_disclosures: { request_delay_ms: 0, retry_backoff_ms: 0, max_retries: 0 } };
const noSleep = async () => {};

test("subCategory extracts the AMFI sub-category", () => {
  assert.equal(subCategory(SMALL), "Small Cap Fund");
  assert.equal(subCategory("Open Ended Schemes ( Equity Scheme - Sectoral/ Thematic )"), "Sectoral/ Thematic");
  assert.equal(subCategory(null), "");
});

test("supports only URLs under the data repo path", () => {
  const adapter = new FundDisclosuresAdapter(HOME);
  assert.equal(adapter.supports(`${HOME}catalog?sub=Small%20Cap%20Fund`), true);
  assert.equal(adapter.supports(`${HOME}portfolios/P1`), true);
  assert.equal(adapter.supports("https://cdn.jsdelivr.net/gh/someone-else/repo/catalog"), false);
  assert.equal(adapter.requiresBrowser, false);
});

test("discoverFunds matches the exact sub-category, dedupes portfolios and drops index funds", async () => {
  const { fetch } = mockFetch(defaultHandler);
  const adapter = new FundDisclosuresAdapter(HOME, { fetch, sleep: noSleep });

  const funds = await adapter.discoverFunds(null, { ...CONFIG, category_url: `${HOME}catalog?sub=Small%20Cap%20Fund` });

  // "Large & Mid Cap Fund" must not match "Mid Cap"/"Small Cap"; P5 has no filing.
  assert.deepEqual(funds, [
    { name: "Alpha Small Cap Fund", url: `${HOME}portfolios/P1` },
    { name: "Beta Small Cap Fund", url: `${HOME}portfolios/P2` }
  ]);
});

test("discoverFunds requires a ?sub= parameter", async () => {
  const { fetch } = mockFetch(defaultHandler);
  const adapter = new FundDisclosuresAdapter(HOME, { fetch, sleep: noSleep });
  await assert.rejects(adapter.discoverFunds(null, { ...CONFIG, category_url: `${HOME}catalog` }), /needs at least one \?sub=/);
});

test("scrapeFundHoldings returns equity rows with ISIN and cleaned names, catalog fetched once", async () => {
  const { fetch, calls } = mockFetch(defaultHandler);
  const adapter = new FundDisclosuresAdapter(HOME, { fetch, sleep: noSleep });

  await adapter.discoverFunds(null, { ...CONFIG, category_url: `${HOME}catalog?sub=Small%20Cap%20Fund` });
  const holdings = await adapter.scrapeFundHoldings(null, `${HOME}portfolios/P1`, CONFIG);

  assert.deepEqual(holdings, [
    { name: "NAVIN FLUORINE INTERNATIONAL L", sector: "Chemicals", instrument: "equity", weightPercentage: 1.97, url: null, isin: "INE048G01026", quantity: 1000, marketValueCr: 25, asOf: "2026-09-30" },
    { name: "Karur Vysya Bank Ltd.", sector: "Banks", instrument: "equity", weightPercentage: 1.5, url: null, isin: "INE036D01028", quantity: 2000, marketValueCr: 12, asOf: "2026-09-30" }
  ]);
  assert.equal(calls.filter((url) => url.endsWith("amfi-lookup.json")).length, 1);
  assert.ok(calls.includes(`${CDN}/portfolios/asof/2026-09-30/P1.json`));
});

test("a pinned as_of month is honoured", async () => {
  const { fetch } = mockFetch(defaultHandler);
  const adapter = new FundDisclosuresAdapter(HOME, { fetch, sleep: noSleep });
  const pinned = { fund_disclosures: { ...CONFIG.fund_disclosures, as_of: "2026-08-31" } };

  const holdings = await adapter.scrapeFundHoldings(null, `${HOME}portfolios/P1`, pinned);
  assert.deepEqual(holdings.map((h) => [h.isin, h.asOf]), [["INE036D01028", "2026-08-31"]]);

  const funds = await adapter.discoverFunds(null, { ...pinned, category_url: `${HOME}catalog?sub=Small%20Cap%20Fund` });
  assert.deepEqual(funds.map((f) => f.name), ["Alpha Small Cap Fund"]);
});

test("falls back to GitHub raw when the CDN is unreachable", async () => {
  const { fetch, calls } = mockFetch((url) => {
    if (url.startsWith(CDN)) throw new Error("connect refused");
    return defaultHandler(url);
  });
  const adapter = new FundDisclosuresAdapter(HOME, { fetch, sleep: noSleep });

  const holdings = await adapter.scrapeFundHoldings(null, `${HOME}portfolios/P1`, CONFIG);
  assert.equal(holdings.length, 2);
  assert.ok(calls.includes(`${RAW}/catalog/amfi-lookup.json`));
  assert.ok(calls.includes(`${RAW}/portfolios/asof/2026-09-30/P1.json`));
});

test("default scraping.json selects fund-disclosures and every category resolves", async () => {
  const configuration = JSON.parse(await readFile(new URL("../config/scraping.json", import.meta.url), "utf8"));
  assert.equal(configuration.source, "fund-disclosures");
  const registry = createSourceRegistry(configuration);
  for (const category of normalizeCategories(configuration)) {
    assert.ok(registry.resolve(category.url) instanceof FundDisclosuresAdapter, category.name);
    assert.ok(new URL(category.url).searchParams.getAll("sub").length > 0, category.name);
  }
  assert.ok(registry.resolve(registry.defaultUrl) instanceof FundDisclosuresAdapter);
});

test("stocks with an ISIN collapse spelling variants into one row", () => {
  const db = createDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    const legacy = repositories.holdings.upsertStock({ name: "Karur Vysya Bank Ltd." });
    const a = repositories.holdings.upsertStock({ name: "Karur Vysya Bank Ltd.", isin: "INE036D01028" });
    const b = repositories.holdings.upsertStock({ name: "Karur Vysya Bank Limited", isin: "INE036D01028" });
    const c = repositories.holdings.upsertStock({ name: "EQ - KARUR VYSYA BANK", isin: "INE036D01028" });
    assert.equal(a, legacy);
    assert.equal(b, legacy);
    assert.equal(c, legacy);

    // Same label, different ISIN: kept apart, disambiguated by ISIN.
    const other = repositories.holdings.upsertStock({ name: "Karur Vysya Bank Ltd.", isin: "INE000000000" });
    assert.notEqual(other, legacy);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stocks").get().n, 2);

    // Name-only sources still upsert by name.
    assert.equal(repositories.holdings.upsertStock({ name: "Plain Co" }), repositories.holdings.upsertStock({ name: "Plain Co" }));
  } finally {
    db.close();
  }
});
