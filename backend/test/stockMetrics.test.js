import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import { extractStockMetrics } from "../src/scrapers/stockMetrics.js";
import { StockScraper } from "../src/scrapers/stockScraper.js";

/**
 * A fake Playwright page exposing only what the extractor uses:
 *  - `locator(xpath=...)` → a locator over the configured node list;
 *  - `evaluate(fn, arg)` for the embedded `__NEXT_DATA__` payload reader.
 *
 * `nodes` maps an XPath expression → array of node doubles. A node is either a
 * string (text only) or `{ text, attr, next, parent }` so label-sibling reads work.
 */
function buildPage({ title = "Stock Page", url = "https://groww.in/stocks/x", nextData = null, nodes = {} } = {}) {
  const toNode = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return { text: value, attr: null, next: null, parent: null };
    return { text: value.text ?? null, attr: value.attr ?? null, next: value.next ?? null, parent: value.parent ?? null };
  };

  const single = (raw) => {
    const node = toNode(raw);
    return {
      textContent: async () => node?.text ?? null,
      getAttribute: async () => node?.attr ?? null,
      evaluate: async (fn, arg) =>
        fn(
          {
            textContent: node?.text ?? null,
            nextElementSibling: node?.next ? { textContent: node.next } : null,
            parentElement: node?.parent ? { textContent: node.parent } : null
          },
          arg
        )
    };
  };

  return {
    url: () => url,
    title: async () => title,
    locator(expression) {
      const xpath = expression.startsWith("xpath=") ? expression.slice("xpath=".length) : expression;
      const values = nodes[xpath] ?? [];
      return {
        count: async () => values.length,
        first: () => single(values[0]),
        nth: (index) => single(values[index])
      };
    },
    // The extractor's payload reader runs `page.evaluate(fn, path)` and reads
    // `document.getElementById("__NEXT_DATA__")`, so emulate the sheet here.
    async evaluate(fn, arg) {
      if (nextData === null) return null;
      const original = globalThis.document;
      globalThis.document = {
        getElementById: (id) => (id === "__NEXT_DATA__" ? { textContent: JSON.stringify(nextData) } : null)
      };
      try {
        return await fn(arg);
      } finally {
        if (original === undefined) delete globalThis.document;
        else globalThis.document = original;
      }
    }
  };
}

const CONFIGURATION = {
  selectors: {
    stock_page: {
      payload_root: "props.pageProps.stockData",
      metrics: {
        core_identifiers_and_market_metrics: {
          ticker_and_exchange: "//h1[contains(@class, 'head')]",
          live_price: "//div[contains(@class, 'liveprice')]//span"
        },
        valuation_and_fundamental_ratios: {
          market_cap: "//tr[td[contains(text(), 'Market Cap')]]/td[2]",
          pe_ratio: "//tr[td[contains(text(), 'PE Ratio')]]/td[2]"
        }
      },
      hints: {
        market_cap: { labels: ["Market Cap"], payload: "fundamentals[Market Cap].value" },
        pe_ratio: { payload: "fundamentals[P/E Ratio(TTM)].value" }
      },
      payload: { details: "details" }
    }
  }
};

test("extractStockMetrics reads configured XPaths and tags provenance", async () => {
  const page = buildPage({
    url: "https://groww.in/stocks/sobha-ltd",
    nodes: {
      "//h1[contains(@class, 'head')]": ["Sobha"],
      "//div[contains(@class, 'liveprice')]//span": ["₹1,188.40"]
    }
  });
  const result = await extractStockMetrics({ page, configuration: CONFIGURATION });

  assert.equal(result.name, "Sobha");
  assert.equal(result.url, "https://groww.in/stocks/sobha-ltd");
  assert.equal(result.metrics.core_identifiers_and_market_metrics.ticker_and_exchange, "Sobha");
  assert.equal(result.metrics.core_identifiers_and_market_metrics.live_price, "₹1,188.40");
  assert.equal(result.provenance.ticker_and_exchange, "xpath");
  assert.equal(result.provenance.live_price, "xpath");
});

test("extractStockMetrics falls back to the embedded payload and records the source", async () => {
  const nextData = {
    props: {
      pageProps: {
        stockData: {
          fundamentals: [
            { name: "Market Cap", value: "₹12,752Cr" },
            { name: "P/E Ratio(TTM)", value: "55.29" }
          ],
          details: { fullName: "Sobha" }
        }
      }
    }
  };
  const page = buildPage({ nextData });
  const result = await extractStockMetrics({ page, configuration: CONFIGURATION });

  // The configured table XPaths match nothing on this page, so the payload wins.
  assert.equal(result.metrics.valuation_and_fundamental_ratios.market_cap, "₹12,752Cr");
  assert.equal(result.metrics.valuation_and_fundamental_ratios.pe_ratio, "55.29");
  assert.equal(result.provenance.market_cap, "payload");
  assert.equal(result.provenance.pe_ratio, "payload");
  assert.deepEqual(result.payload.details, { fullName: "Sobha" });
});

test("extractStockMetrics reads a label's sibling when the table XPath is stale", async () => {
  const page = buildPage({
    nodes: {
      "//*[normalize-space(text())='Market Cap']": [{ text: "Market Cap", next: "₹12,752Cr" }]
    }
  });
  const result = await extractStockMetrics({ page, configuration: CONFIGURATION });
  assert.equal(result.metrics.valuation_and_fundamental_ratios.market_cap, "₹12,752Cr");
  assert.equal(result.provenance.market_cap, "label");
});

test("extractStockMetrics never throws — absent metrics are null with diagnostics", async () => {
  const page = buildPage({});
  const result = await extractStockMetrics({ page, configuration: CONFIGURATION });
  assert.equal(result.metrics.valuation_and_fundamental_ratios.market_cap, null);
  assert.equal(result.provenance.market_cap, "none");
  assert.ok(result.diagnostics.some((line) => /No configured stock metric could be read/.test(line)));
});

test("extractStockMetrics returns a text list for unpredicated (trend) selectors", async () => {
  const configuration = {
    selectors: {
      stock_page: {
        metrics: { financial_performance_trends: { revenue_history: "//div[contains(@id, 'financials')]//table//tr" } }
      }
    }
  };
  const page = buildPage({
    nodes: {
      "//div[contains(@id, 'financials')]//table//tr": ["2024 3217.882", "2025 4162.759"]
    }
  });
  const result = await extractStockMetrics({ page, configuration });
  assert.deepEqual(result.metrics.financial_performance_trends.revenue_history, ["2024 3217.882", "2025 4162.759"]);
});

test("repositories persist stock metrics and expose them on the leaderboard", () => {
  const db = createDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    const fund = repositories.funds.upsert({ name: "Fund A", url: "https://groww.in/fund-a", category: "Small Cap" });
    repositories.holdings.replaceFundHoldings(fund.id, [
      { name: "Sobha Ltd", url: "https://groww.in/stocks/sobha-ltd", weightPercentage: 2.3 }
    ]);
    const stockId = repositories.holdings.upsertStock({ name: "Sobha Ltd", url: "https://groww.in/stocks/sobha-ltd" });
    repositories.stockMetrics.upsert(stockId, {
      url: "https://groww.in/stocks/sobha-ltd",
      title: "Sobha",
      metrics: { valuation_and_fundamental_ratios: { pe_ratio: "55.29" } },
      provenance: { pe_ratio: "payload" },
      raw: { details: { fullName: "Sobha" } }
    });
    repositories.aggregation.recompute();

    const stored = repositories.stockMetrics.get(stockId);
    assert.equal(stored.metrics.valuation_and_fundamental_ratios.pe_ratio, "55.29");
    assert.equal(stored.page_title, "Sobha");

    const [row] = repositories.aggregation.leaderboard(10, 0);
    assert.equal(row.name, "Sobha Ltd");
    assert.equal(row.stock_url, "https://groww.in/stocks/sobha-ltd");
    assert.equal(row.metrics.valuation_and_fundamental_ratios.pe_ratio, "55.29");

    // The category-scoped query exposes the same fields.
    const [scoped] = repositories.aggregation.leaderboard(10, 0, "Small Cap");
    assert.equal(scoped.metrics.valuation_and_fundamental_ratios.pe_ratio, "55.29");

    // A stock with no metrics yet reports null rather than an empty object.
    assert.equal(repositories.stockMetrics.get(999), null);
  } finally {
    db.close();
  }
});

test("unanalyzed stocks carry scraped metrics into the AI prompt payload", () => {
  const db = createDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    const fund = repositories.funds.upsert({ name: "Fund A", url: "https://groww.in/fund-a", category: "Small Cap" });
    repositories.holdings.replaceFundHoldings(fund.id, [
      { name: "Sobha Ltd", url: "https://groww.in/stocks/sobha-ltd", weightPercentage: 2.3 }
    ]);
    const stockId = repositories.holdings.upsertStock({ name: "Sobha Ltd", url: "https://groww.in/stocks/sobha-ltd" });
    repositories.aggregation.recompute();
    assert.equal(repositories.aggregation.unanalyzed(5)[0].metrics, null);

    repositories.stockMetrics.upsert(stockId, {
      url: "https://groww.in/stocks/sobha-ltd",
      title: "Sobha",
      metrics: { core_identifiers_and_market_metrics: { live_price: "₹1,188.40" } },
      provenance: {},
      raw: null
    });
    const [pending] = repositories.aggregation.unanalyzed(5);
    assert.equal(pending.metrics.core_identifiers_and_market_metrics.live_price, "₹1,188.40");
  } finally {
    db.close();
  }
});

test("stock scraper visits each unique stock page and persists its metrics", async () => {
  const db = createDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    const fund = repositories.funds.upsert({ name: "Fund A", url: "https://groww.in/fund-a", category: "Small Cap" });
    const holdings = [
      { name: "Sobha Ltd", url: "https://groww.in/stocks/sobha-ltd", weightPercentage: 2.3 },
      // Duplicated stock (same name/URL): its page must be visited once, not twice.
      { name: "Sobha Ltd", url: "https://groww.in/stocks/sobha-ltd", weightPercentage: 1.1 },
      // No detail URL: skipped (repo/cash artifacts have no stock page).
      { name: "Reverse Repo", url: null, weightPercentage: 13.42 }
    ];
    const visited = [];
    const adapter = {
      async scrapeFundHoldings() {
        return holdings;
      },
      async scrapeStockMetrics(_page, url) {
        visited.push(url);
        return {
          url,
          name: "Sobha",
          metrics: { core_identifiers_and_market_metrics: { live_price: "₹1,188.40" } },
          provenance: { live_price: "xpath" },
          payload: {},
          diagnostics: []
        };
      }
    };
    const registry = { defaultUrl: "https://groww.in/", resolve: () => adapter };

    const scraper = new StockScraper({
      configuration: {},
      sourceRegistry: registry,
      repositories,
      withBrowser: async (_configuration, operation) => operation({})
    });
    const result = await scraper.run([fund]);

    assert.deepEqual(visited, ["https://groww.in/stocks/sobha-ltd"]);
    assert.equal(result.stocks, 2);
    assert.equal(result.stock_metrics, 1);

    const stockId = repositories.stocks.getById(
      repositories.holdings.upsertStock({ name: "Sobha Ltd", url: "https://groww.in/stocks/sobha-ltd" })
    ).id;
    assert.equal(
      repositories.stockMetrics.get(stockId).metrics.core_identifiers_and_market_metrics.live_price,
      "₹1,188.40"
    );
  } finally {
    db.close();
  }
});

test("a stock page failure does not abort the scrape", async () => {
  const db = createDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    const fund = repositories.funds.upsert({ name: "Fund A", url: "https://groww.in/fund-a", category: "Small Cap" });
    const adapter = {
      async scrapeFundHoldings() {
        return [{ name: "Repo", url: null, weightPercentage: 5 }];
      },
      async scrapeStockMetrics() {
        throw new Error("should not be called");
      }
    };
    const registry = { defaultUrl: "https://groww.in/", resolve: () => adapter };
    const scraper = new StockScraper({
      configuration: {},
      sourceRegistry: registry,
      repositories,
      withBrowser: async (_configuration, operation) => operation({})
    });
    const result = await scraper.run([fund]);
    assert.deepEqual(result, { stocks: 1, stock_metrics: 0 });
  } finally {
    db.close();
  }
});
