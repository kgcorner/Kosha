import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import { createSourceRegistry } from "../src/scrapers/sourceRegistry.js";
import { ScrapeDryRunService } from "../src/services/scrapeDryRun.js";
import { normalizeCategories } from "../src/scrapers/categoryList.js";

const CONFIGURATION = {
  source: "groww",
  homepage_url: "https://groww.in/",
  categories: [
    { category: "Small Cap", url: "https://groww.in/mutual-funds/small", xpath: "//a" },
    { category: "Large Cap", url: "https://groww.in/mutual-funds/large", xpath: "//a" }
  ],
  selectors: {
    mf_list_page: { fund_row: "//a" },
    mf_detail_page: { holding_row: "//tr", stock_name: ".//td[1]", stock_url: ".//a/@href" },
    stock_page: {
      metrics: {
        core_identifiers_and_market_metrics: { live_price: "//span" },
        valuation_and_fundamental_ratios: { pe_ratio: "//td" }
      }
    }
  }
};

// A stand-in adapter: records the fund and stock URLs it is asked to scrape and
// returns canned holdings/metrics, so the service's selection/orchestration can
// be asserted without touching the network.
function buildAdapter({ funds, holdings, stockMetrics = {} }) {
  const scraped = [];
  const scrapedStocks = [];
  return {
    scraped,
    scrapedStocks,
    async discoverFunds(_page, configuration) {
      assert.equal(configuration.category_url, "https://groww.in/mutual-funds/small");
      return funds;
    },
    async scrapeFundHoldings(_page, url) {
      scraped.push(url);
      return holdings;
    },
    async scrapeStockMetrics(_page, url) {
      scrapedStocks.push(url);
      if (stockMetrics.fail) throw new Error("stock page boom");
      return {
        url,
        name: "Stub Stock",
        metrics: stockMetrics.metrics ?? { core_identifiers_and_market_metrics: { live_price: "₹100" } },
        provenance: stockMetrics.provenance ?? { live_price: "xpath" },
        payload: {},
        diagnostics: stockMetrics.diagnostics ?? []
      };
    }
  };
}

function serviceFor({ funds, holdings, stockMetrics }) {
  const adapter = buildAdapter({ funds, holdings, stockMetrics });
  const registry = { resolve: () => adapter };
  const service = new ScrapeDryRunService({
    configuration: CONFIGURATION,
    sourceRegistry: registry,
    withBrowser: (_configuration, operation) => operation({})
  });
  return { service, adapter };
}

test("normalizeCategories accepts the Groww and legacy category shapes", () => {
  assert.deepEqual(normalizeCategories(CONFIGURATION), [
    { name: "Small Cap", url: "https://groww.in/mutual-funds/small", xpath: "//a" },
    { name: "Large Cap", url: "https://groww.in/mutual-funds/large", xpath: "//a" }
  ]);
  assert.deepEqual(normalizeCategories({ category_url: "https://groww.in/all" }), [
    { name: "default", url: "https://groww.in/all", xpath: undefined }
  ]);
  assert.throws(() => normalizeCategories({}), /must define categories or category_url/);
});

test("dry run samples one category, one fund and lists holdings with all data points", async () => {
  const { service, adapter } = serviceFor({
    funds: [
      { name: "Fund A", url: "https://groww.in/mutual-funds/fund-a" },
      { name: "Fund B", url: "https://groww.in/mutual-funds/fund-b" }
    ],
    holdings: [
      { name: "Repo", sector: "Unspecified", instrument: "Repo", weightPercentage: 2.68, url: "https://groww.in/stocks/repo" },
      { name: "HDFC Bank Ltd", sector: "Financial", instrument: "Equity", weightPercentage: 1.75, url: "https://groww.in/stocks/hdfc-bank-ltd" },
      { name: "ICICI Bank Ltd", sector: "Financial", instrument: "Equity", weightPercentage: 1.6, url: "https://groww.in/stocks/icici-bank-ltd" },
      { name: "Reliance Industries", sector: "Energy", instrument: "Equity", weightPercentage: 1.2, url: "https://groww.in/stocks/reliance-industries" },
      { name: "TCS", sector: "Technology", instrument: "Equity", weightPercentage: 1.1, url: "https://groww.in/stocks/tcs" },
      { name: "Infosys", sector: "Technology", instrument: "Equity", weightPercentage: 1.0, url: "https://groww.in/stocks/infosys" }
    ]
  });

  const result = await service.run({ category: "Small Cap", limit: 5 });
  assert.deepEqual(result.category, { name: "Small Cap", url: "https://groww.in/mutual-funds/small" });
  assert.equal(result.fund.name, "Fund A");
  assert.equal(result.funds_found, 2);
  assert.equal(result.holdings_found, 6);
  // Capped at `limit` but the total is reported, so tuning sees the real count.
  assert.equal(result.holdings.length, 5);
  assert.equal(result.holdings[0].name, "Repo");
  assert.equal(result.holdings[0].sector, "Unspecified");
  assert.equal(result.holdings[0].instrument, "Repo");
  assert.equal(result.holdings[0].weightPercentage, 2.68);
  assert.deepEqual(adapter.scraped, ["https://groww.in/mutual-funds/fund-a"]);
  assert.deepEqual(result.diagnostics, ["Showing the first 5 of 6 parsed holding(s)."]);
});

test("dry run visits each listed holding's stock page and attaches its metrics", async () => {
  const { service, adapter } = serviceFor({
    funds: [{ name: "Fund A", url: "https://groww.in/mutual-funds/fund-a" }],
    holdings: [
      { name: "HDFC Bank Ltd", sector: "Financial", instrument: "Equity", weightPercentage: 1.75, url: "https://groww.in/stocks/hdfc-bank-ltd" },
      { name: "Repo", sector: "Unspecified", instrument: "Repo", weightPercentage: 2.68, url: null }
    ],
    stockMetrics: {
      metrics: {
        core_identifiers_and_market_metrics: { live_price: "₹728.85" },
        valuation_and_fundamental_ratios: { pe_ratio: "13.62" }
      },
      provenance: { live_price: "hint", pe_ratio: "payload" }
    }
  });

  const result = await service.run({ limit: 5 });
  // Only the holding that has a detail URL is followed.
  assert.deepEqual(adapter.scrapedStocks, ["https://groww.in/stocks/hdfc-bank-ltd"]);
  assert.deepEqual(result.holdings[0].metrics, {
    core_identifiers_and_market_metrics: { live_price: "₹728.85" },
    valuation_and_fundamental_ratios: { pe_ratio: "13.62" }
  });
  assert.equal(result.holdings[0].metrics_provenance.pe_ratio, "payload");
  // A holding with no URL yields null metrics and is called out in diagnostics.
  assert.equal(result.holdings[1].metrics, null);
  assert.ok(result.diagnostics.some((line) => /no stock detail URL/.test(line)));
});

test("dry run degrades gracefully when a stock page fails", async () => {
  const { service } = serviceFor({
    funds: [{ name: "Fund A", url: "https://groww.in/mutual-funds/fund-a" }],
    holdings: [
      { name: "HDFC Bank Ltd", sector: "Financial", instrument: "Equity", weightPercentage: 1.75, url: "https://groww.in/stocks/hdfc-bank-ltd" }
    ],
    stockMetrics: { fail: true }
  });

  const result = await service.run();
  assert.equal(result.holdings[0].metrics, null);
  assert.ok(result.diagnostics.some((line) => /stock page scrape failed \(stock page boom\)/.test(line)));
});

test("dry run defaults to the first category and first fund", async () => {
  const { service } = serviceFor({
    funds: [{ name: "Fund A", url: "https://groww.in/mutual-funds/fund-a" }],
    holdings: [
      {
        name: "HDFC Bank Ltd",
        sector: "Financial",
        instrument: "Equity",
        weightPercentage: 1.75,
        url: "https://groww.in/stocks/hdfc-bank-ltd"
      }
    ]
  });

  const result = await service.run();
  assert.equal(result.category.name, "Small Cap");
  assert.equal(result.fund.name, "Fund A");
  assert.equal(result.holdings.length, 1);
  assert.deepEqual(result.diagnostics, []);
});

test("dry run selects a fund by name or index", async () => {
  const funds = [
    { name: "Fund A", url: "https://groww.in/mutual-funds/fund-a" },
    { name: "Quant Fund", url: "https://groww.in/mutual-funds/quant" }
  ];
  const { service } = serviceFor({
    funds,
    holdings: [{ name: "X", sector: null, instrument: null, weightPercentage: null }]
  });

  assert.equal((await service.run({ fund: 1 })).fund.name, "Quant Fund");
  assert.equal((await service.run({ fund: "quant" })).fund.name, "Quant Fund");
  assert.equal((await service.run({ fund: "missing" })).fund, null);
});

test("dry run rejects an unknown category with the available list", async () => {
  const { service } = serviceFor({ funds: [], holdings: [] });
  await assert.rejects(
    () => service.run({ category: "Nope" }),
    /Unknown dry-run category "Nope"\. Available: Small Cap, Large Cap/
  );
});

test("dry run reports diagnostics when nothing parses", async () => {
  const { service } = serviceFor({
    funds: [{ name: "Fund A", url: "https://groww.in/mutual-funds/fund-a" }],
    holdings: []
  });
  const result = await service.run();
  assert.equal(result.holdings_found, 0);
  assert.match(result.diagnostics[0], /matched no rows/);
});

test("dry run flags holdings without a parsable weight", async () => {
  const { service } = serviceFor({
    funds: [{ name: "Fund A", url: "https://groww.in/mutual-funds/fund-a" }],
    holdings: [
      { name: "A", sector: "S", instrument: "Equity", weightPercentage: 1.5, url: "https://groww.in/stocks/a" },
      { name: "B", sector: "S", instrument: "Equity", weightPercentage: null, url: "https://groww.in/stocks/b" }
    ]
  });
  const result = await service.run();
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], /1 holding\(s\) have no parsable weight/);
});

test("dry run service exposes the configurable categories", () => {
  const { service } = serviceFor({ funds: [], holdings: [] });
  assert.deepEqual(service.categories().map((entry) => entry.name), ["Small Cap", "Large Cap"]);
});

test("leaderboard scopes consensus and rank to a single category", () => {
  const db = createDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    const small = repositories.funds.upsert({ name: "Small Fund", url: "https://groww.in/small", category: "Small Cap" });
    const small2 = repositories.funds.upsert({ name: "Small Fund 2", url: "https://groww.in/small-2", category: "Small Cap" });
    const large = repositories.funds.upsert({ name: "Large Fund", url: "https://groww.in/large", category: "Large Cap" });
    const holding = (name, weight = null) => ({ name, weightPercentage: weight });

    repositories.holdings.replaceFundHoldings(small.id, [holding("Alpha Ltd", 2), holding("Beta Ltd", 1)]);
    repositories.holdings.replaceFundHoldings(small2.id, [holding("Beta Ltd", 3)]);
    repositories.holdings.replaceFundHoldings(large.id, [holding("Alpha Ltd", 5), holding("Beta Ltd", 4)]);
    repositories.aggregation.recompute();

    // Globally Beta leads on consensus (3 funds vs Alpha's 2).
    const global = repositories.aggregation.leaderboard(10, 0);
    assert.equal(global[0].name, "Beta Ltd");
    assert.equal(global[0].consensus_score, 3);
    assert.deepEqual(global[0].categories.sort(), ["Large Cap", "Small Cap"]);

    // Within Small Cap the ranks are recomputed from category-scoped consensus,
    // not inherited from the global ranking.
    const smallCap = repositories.aggregation.leaderboard(10, 0, "Small Cap");
    assert.deepEqual(smallCap.map((row) => row.name), ["Beta Ltd", "Alpha Ltd"]);
    assert.deepEqual(smallCap.map((row) => row.rank), [1, 2]);
    assert.equal(smallCap[0].consensus_score, 2);
    assert.equal(smallCap[1].consensus_score, 1);
    assert.equal(smallCap[0].total_weight_sum, 4, "weights sum across the category's funds");
    assert.equal(smallCap[0].weight_avg, 2, "per-fund average weight across the category's funds");
    assert.equal(smallCap[0].weight_min, 1);
    assert.equal(smallCap[0].weight_max, 3);
    assert.deepEqual(smallCap[0].categories.sort(), ["Large Cap", "Small Cap"]);

    // A category nobody holds returns nothing.
    assert.deepEqual(repositories.aggregation.leaderboard(10, 0, "ELSS"), []);
  } finally {
    db.close();
  }
});

test("fund repository lists distinct categories for the filter", () => {
  const db = createDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    repositories.funds.upsert({ name: "A", url: "https://groww.in/a", category: "Small Cap" });
    repositories.funds.upsert({ name: "B", url: "https://groww.in/b", category: "Large Cap" });
    repositories.funds.upsert({ name: "C", url: "https://groww.in/c", category: "Small Cap" });
    repositories.funds.upsert({ name: "D", url: "https://groww.in/d", category: null });
    assert.deepEqual(repositories.funds.listCategories(), ["Large Cap", "Small Cap"]);
  } finally {
    db.close();
  }
});

test("the configured categories all resolve to a source for the dry run", () => {
  const registry = createSourceRegistry(CONFIGURATION);
  const service = new ScrapeDryRunService({ configuration: CONFIGURATION, sourceRegistry: registry });
  assert.equal(service.categories().length, 2);
});


