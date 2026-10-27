import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import { GrowwAdapter } from "../src/scrapers/growwAdapter.js";
import { MoneycontrolAdapter } from "../src/scrapers/moneycontrolAdapter.js";
import { MutualFundScraper } from "../src/scrapers/mutualFundScraper.js";
import { createSourceRegistry } from "../src/scrapers/sourceRegistry.js";
import { parsePercentage, readXPathValue } from "../src/scrapers/xpath.js";

test("Groww source supports pages under groww.in", () => {
  const adapter = new GrowwAdapter("https://groww.in/");
  assert.equal(adapter.supports("https://groww.in/mutual-funds/filter?sub_cat=%5B%22Mid+Cap%22%5D"), true);
  assert.equal(adapter.supports("https://www.moneycontrol.com/mutual-funds/example"), false);
  assert.equal(adapter.supports("not a URL"), false);
});

test("Moneycontrol source supports pages under its configured homepage", () => {
  const adapter = new MoneycontrolAdapter("https://www.moneycontrol.com/");
  assert.equal(adapter.supports("https://www.moneycontrol.com/mutual-funds/example"), true);
  assert.equal(adapter.supports("https://example.com/funds"), false);
  assert.equal(adapter.supports("not a URL"), false);
});

test("Groww discoverFunds reads name and href from each matched <a> node", async () => {
  const nodes = [
    { textContent: async () => "  Parag Parikh Flexi Cap Fund  ", getAttribute: async () => "/mutual-funds/parag-parikh-flexi-cap-fund-direct-growth" },
    { textContent: async () => "HDFC Balanced Advantage Fund", getAttribute: async () => "https://groww.in/mutual-funds/hdfc-balanced-advantage" }
  ];
  let navigated = null;
  const page = {
    async goto(url) { navigated = url; },
    title: async () => "Groww Mutual Funds",
    url: () => "https://groww.in/mutual-funds/filter?sub_cat=%5B%22Flexi+Cap%22%5D",
    locator() {
      return {
        count: async () => nodes.length,
        nth(index) { return nodes[index]; }
      };
    }
  };
  const adapter = new GrowwAdapter("https://groww.in/");
  const configuration = {
    category_url: "https://groww.in/mutual-funds/filter?sub_cat=%5B%22Flexi+Cap%22%5D",
    category_xpath: "//a[contains(@class, 'tableCells_srLink__PZHGP')]",
    selectors: { mf_list_page: { fund_row: "//a[contains(@class, 'tableCells_srLink__PZHGP')]" } }
  };
  const funds = await adapter.discoverFunds(page, configuration);
  assert.equal(navigated, configuration.category_url);
  assert.deepEqual(funds, [
    { name: "Parag Parikh Flexi Cap Fund", url: "https://groww.in/mutual-funds/parag-parikh-flexi-cap-fund-direct-growth" },
    { name: "HDFC Balanced Advantage Fund", url: "https://groww.in/mutual-funds/hdfc-balanced-advantage" }
  ]);
});

test("Groww scrapeFundHoldings reads the full holdings row (name, sector, weight)", async () => {
  // One row with the four real Groww columns: Name | Sector | Instruments | Assets.
  const rows = [
    { name: "Repo", sector: "Unspecified", instrument: "Repo", weight: "2.68%" },
    { name: "HDFC Bank Ltd", sector: "Financial", instrument: "Equity", weight: "1.75%" }
  ];
  const columnKey = (expression) =>
    expression.includes("holdings_companyName")
      ? "name"
      : expression.includes("td[2]")
        ? "sector"
        : expression.includes("td[3]")
          ? "instrument"
          : "weight";
  const page = {
    async goto() {},
    locator(expression) {
      assert.ok(expression.includes("ancestor::tr"), "row locator is used for the holding rows");
      return {
        count: async () => rows.length,
        nth(index) {
          const row = rows[index];
          return {
            textContent: async () => Object.values(row).join(" "),
            locator: (inner) => {
              const key = columnKey(inner);
              return {
                count: async () => 1,
                first: () => ({ textContent: async () => row[key] })
              };
            }
          };
        }
      };
    }
  };
  const adapter = new GrowwAdapter("https://groww.in/");
  const holdings = await adapter.scrapeFundHoldings(page, "https://groww.in/mutual-funds/example", {
    selectors: {
      mf_detail_page: {
        view_all_holdings_button: "",
        holding_row: "//td[contains(@class, 'holdings_companyName')]/ancestor::tr",
        stock_name: ".//td[contains(@class, 'holdings_companyName')]",
        stock_sector: "./td[2]",
        stock_instrument: "./td[3]",
        stock_weight: "./td[4]"
      }
    }
  });
  assert.deepEqual(holdings, [
    { name: "Repo", sector: "Unspecified", instrument: "Repo", weightPercentage: 2.68, url: null },
    { name: "HDFC Bank Ltd", sector: "Financial", instrument: "Equity", weightPercentage: 1.75, url: null }
  ]);
});

test("Groww scrapeFundHoldings falls back to row text and null weight without column selectors", async () => {
  const page = {
    async goto() {},
    locator(expression) {
      assert.ok(expression.includes("ancestor::tr"));
      return {
        count: async () => 1,
        nth() {
          return { textContent: async () => "  ICICI Bank Ltd.  Financial  Equity  " };
        }
      };
    }
  };
  const adapter = new GrowwAdapter("https://groww.in/");
  const holdings = await adapter.scrapeFundHoldings(page, "https://groww.in/mutual-funds/example", {
    selectors: {
      mf_detail_page: {
        view_all_holdings_button: "",
        holding_row: "//td[contains(@class, 'holdings_companyName')]/ancestor::tr"
      }
    }
  });
  assert.deepEqual(holdings, [
    {
      name: "ICICI Bank Ltd. Financial Equity",
      sector: null,
      instrument: null,
      weightPercentage: null,
      url: null
    }
  ]);
});

test("legacy span-based holdings XPath still yields names (row text fallback)", async () => {
  const names = ["HDFC Bank", "ICICI Bank Ltd.", "Reliance Industries"];
  const page = {
    async goto() {},
    locator() {
      return {
        count: async () => names.length,
        nth(index) {
          return { textContent: async () => names[index] };
        }
      };
    }
  };
  const adapter = new GrowwAdapter("https://groww.in/");
  const holdings = await adapter.scrapeFundHoldings(page, "https://groww.in/mutual-funds/example", {
    selectors: {
      mf_detail_page: {
        view_all_holdings_button: "",
        holding_row: "//div[@id='holdingsContainer']//tr//span[contains(@class, 'holdings_link__kjPQ5')]"
      }
    }
  });
  assert.deepEqual(holdings, [
    { name: "HDFC Bank", sector: null, instrument: null, weightPercentage: null, url: null },
    { name: "ICICI Bank Ltd.", sector: null, instrument: null, weightPercentage: null, url: null },
    { name: "Reliance Industries", sector: null, instrument: null, weightPercentage: null, url: null }
  ]);
});

test("replaceFundHoldings de-duplicates repeated stocks instead of throwing UNIQUE error", () => {
  const db = createDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    const fund = repositories.funds.upsert({ name: "Fund A", url: "https://groww.in/fund-a", category: "Flexi Cap" });
    // Groww renders the same stock more than once on a fund page; this previously
    // crashed with SQLITE_CONSTRAINT_UNIQUE on fund_holdings(fund_id, stock_id).
    const holdings = [
      { name: "HDFC Bank", url: null, weightPercentage: null },
      { name: "HDFC Bank", url: null, weightPercentage: null },
      { name: "Reliance Industries", url: null, weightPercentage: null }
    ];
    repositories.holdings.replaceFundHoldings(fund.id, holdings);
    const rows = db.prepare("SELECT stock_id FROM fund_holdings WHERE fund_id = ?").all(fund.id);
    assert.equal(rows.length, 2);
  } finally {
    db.close();
  }
});

test("registry selects the source configured for the dynamic category URL", () => {
  const registry = createSourceRegistry({
    source: "groww",
    homepage_url: "https://groww.in/",
    category_url: "https://groww.in/mutual-funds/category.html",
    selectors: {}
  });
  assert.ok(registry.resolve("https://groww.in/stock/example"));
  assert.throws(() => registry.resolve("https://example.com/stock"), /No scraper source supports URL/);
});

test("registry derives a default URL so stock scraping does not need a single category_url", () => {
  const fromHomepage = createSourceRegistry({
    source: "groww",
    homepage_url: "https://groww.in/",
    selectors: {}
  });
  assert.equal(fromHomepage.defaultUrl, "https://groww.in/");

  const fromCategories = createSourceRegistry({
    source: "groww",
    categories: [{ category: "Small Cap", url: "https://groww.in/mutual-funds/small-cap" }],
    selectors: {}
  });
  assert.equal(fromCategories.defaultUrl, "https://groww.in");

  assert.throws(
    () => createSourceRegistry({ source: "groww", selectors: {} }),
    /must define homepage_url, category_url, or categories/
  );

  assert.throws(
    () => createSourceRegistry({ source: "unknown", homepage_url: "https://groww.in/", selectors: {} }),
    /Unknown scraper source/
  );
});

test("fund scraper normalises Groww categories and falls back to category_url", () => {
  const multi = new MutualFundScraper({
    configuration: {
      categories: [
        { category: "Mid Cap", url: "https://groww.in/mutual-funds/mid-cap", xpath: "//a" },
        { name: "Large Cap", url: "https://groww.in/mutual-funds/large-cap", xpath: "//a" }
      ]
    }
  });
  assert.deepEqual(multi.categoryList(), [
    { name: "Mid Cap", url: "https://groww.in/mutual-funds/mid-cap", xpath: "//a" },
    { name: "Large Cap", url: "https://groww.in/mutual-funds/large-cap", xpath: "//a" }
  ]);

  const legacy = new MutualFundScraper({
    configuration: { category_url: "https://groww.in/mutual-funds/default" }
  });
  assert.deepEqual(legacy.categoryList(), [
    { name: "default", url: "https://groww.in/mutual-funds/default", xpath: undefined }
  ]);

  const missing = new MutualFundScraper({ configuration: {} });
  assert.throws(() => missing.categoryList(), /must define categories or category_url/);
});

test("all Groww categories from scraping.json resolve under the groww source", async () => {
  const configuration = JSON.parse(
    await readFile(new URL("../config/scraping.json", import.meta.url), "utf8")
  );
  assert.equal(configuration.source, "groww");
  assert.equal(configuration.categories.length, 7);

  const registry = createSourceRegistry(configuration);
  for (const category of configuration.categories) {
    assert.ok(
      registry.resolve(category.url),
      `expected an adapter for category "${category.category}"`
    );
    assert.ok(category.category && category.url && category.xpath, "each category needs category, url and xpath");
  }
});

test("selector helpers extract XPath text and attribute values", async () => {
  const calls = [];
  const locator = {
    first() { return this; },
    async textContent() { return "  7.85%\n "; },
    async getAttribute(name) { return `/${name}/value`; }
  };
  const page = {
    locator(expression) {
      calls.push(expression);
      return locator;
    }
  };

  assert.equal(await readXPathValue(page, ".//td[last()]"), "7.85%");
  assert.equal(await readXPathValue(page, ".//a/@href"), "/href/value");
  assert.deepEqual(calls, ["xpath=.//td[last()]", "xpath=.//a"]);
  assert.equal(await readXPathValue(page, ""), null);
});

test("number parsers handle formatted portfolio weights", () => {
  assert.equal(parsePercentage(" 7.85% "), 7.85);
  assert.equal(parsePercentage("—"), null);
});


test("database repositories persist holdings and aggregate consensus", () => {
  const db = createDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    const firstFund = repositories.funds.upsert({ name: "Fund One", url: "https://example.com/fund-1", category: "Large-Cap" });
    const secondFund = repositories.funds.upsert({ name: "Fund Two", url: "https://example.com/fund-2", category: "Small-Cap" });
    const holding = { name: "Example Ltd", weightPercentage: 7.85 };

    repositories.holdings.replaceFundHoldings(firstFund.id, [holding]);
    repositories.holdings.replaceFundHoldings(secondFund.id, [{ ...holding, weightPercentage: 4.25 }]);
    repositories.aggregation.recompute();

    const [stock] = repositories.aggregation.leaderboard(20, 0);
    assert.equal(stock.name, "Example Ltd");
    assert.equal(stock.consensus_score, 2);
    assert.equal(stock.total_weight_sum, 12.1);
    assert.equal(stock.weight_avg, 6.05, "average of the two per-fund weights (7.85 and 4.25)");
    assert.equal(stock.weight_min, 4.25);
    assert.equal(stock.weight_max, 7.85);
    assert.equal(repositories.funds.list().length, 2);

    assert.equal(firstFund.category, "Large-Cap");
    assert.equal(secondFund.category, "Small-Cap");
    assert.deepEqual(
      repositories.funds.list().map((fund) => fund.category).sort(),
      ["Large-Cap", "Small-Cap"]
    );

    const rediscovered = repositories.funds.upsert({ name: "Fund One", url: "https://example.com/fund-1", category: "Multi-Cap" });
    assert.equal(rediscovered.category, "Large-Cap");
  } finally {
    db.close();
  }
});

test("aggregation ranks Groww-style holdings (no weights) purely by consensus", () => {
  const db = createDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    // Three Groww funds; Groww supplies only stock names (weight = null).
    const fundA = repositories.funds.upsert({ name: "Fund A", url: "https://groww.in/fund-a", category: "Flexi Cap" });
    const fundB = repositories.funds.upsert({ name: "Fund B", url: "https://groww.in/fund-b", category: "Flexi Cap" });
    const fundC = repositories.funds.upsert({ name: "Fund C", url: "https://groww.in/fund-c", category: "Flexi Cap" });
    const holding = (name) => ({ name, weightPercentage: null });

    // HDFC Bank held by all three funds; Reliance by two.
    repositories.holdings.replaceFundHoldings(fundA.id, [holding("HDFC Bank"), holding("Reliance Industries")]);
    repositories.holdings.replaceFundHoldings(fundB.id, [holding("HDFC Bank"), holding("Reliance Industries")]);
    repositories.holdings.replaceFundHoldings(fundC.id, [holding("HDFC Bank")]);
    repositories.aggregation.recompute();

    const leaderboard = repositories.aggregation.leaderboard(20, 0);
    assert.equal(leaderboard[0].name, "HDFC Bank");
    assert.equal(leaderboard[0].consensus_score, 3);
    assert.equal(leaderboard[0].total_weight_sum, 0);
    assert.equal(leaderboard[0].weight_avg, null, "no parsable weights => no per-fund average");
    assert.equal(leaderboard[0].weight_min, null);
    assert.equal(leaderboard[0].weight_max, null);
    assert.equal(leaderboard[1].name, "Reliance Industries");
    assert.equal(leaderboard[1].consensus_score, 2);
  } finally {
    db.close();
  }
});


test("category change detection reports stocks added and removed between runs", () => {
  const db = createDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    const fund = repositories.funds.upsert({ name: "Fund A", url: "https://groww.in/fund-a", category: "Flexi Cap" });

    // Run 1: baseline membership {HDFC, Reliance}; both count as additions vs the empty set.
    repositories.holdings.replaceFundHoldings(fund.id, [
      { name: "HDFC Bank", weightPercentage: null },
      { name: "Reliance Industries", weightPercentage: null }
    ]);
    const first = repositories.categoryChanges.detect();
    assert.notEqual(first.runId, null, "first run records a baseline run");
    assert.equal(first.added, 2);
    assert.equal(first.removed, 0);

    // Run 2: Reliance removed, ICICI added.
    repositories.holdings.replaceFundHoldings(fund.id, [
      { name: "HDFC Bank", weightPercentage: null },
      { name: "ICICI Bank", weightPercentage: null }
    ]);
    const second = repositories.categoryChanges.detect();
    assert.equal(second.added, 1);
    assert.equal(second.removed, 1);

    const changes = repositories.categoryChanges.latestChanges("Flexi Cap");
    assert.equal(changes.run_id, second.runId);
    assert.deepEqual(changes.removed.map((stock) => stock.name), ["Reliance Industries"]);
    assert.deepEqual(changes.added.map((stock) => stock.name), ["ICICI Bank"]);

    // A category with no recorded change history returns empty lists.
    const unknown = repositories.categoryChanges.latestChanges("Mid Cap");
    assert.equal(unknown.run_id, null);
    assert.deepEqual(unknown.removed, []);
    assert.deepEqual(unknown.added, []);
  } finally {
    db.close();
  }
});

test("migrating an existing database backfills the per-fund weight stats", () => {
  // Simulate a pre-migration database: run the current schema, then wipe the
  // stats (and recompute) exactly as the stale rows looked after the columns
  // were first added. Reopening must derive them again from fund_holdings.
  const directory = mkdtempSync(join(tmpdir(), "weight-backfill-"));
  const databasePath = join(directory, "stocks.sqlite");
  try {
    const db = createDatabase(databasePath);
    const repositories = createRepositories(db);
    const fund = repositories.funds.upsert({ name: "Fund One", url: "https://example.com/fund-1", category: "Large Cap" });
    repositories.holdings.replaceFundHoldings(fund.id, [
      { name: "Example Ltd", weightPercentage: 7.85 },
      { name: "No Weight Ltd", weightPercentage: null }
    ]);
    repositories.aggregation.recompute();
    db.prepare("UPDATE stock_aggregations SET weight_avg = NULL, weight_min = NULL, weight_max = NULL").run();
    db.close();

    // Reopen the same file: the migration runs on connect and must repopulate.
    const reopened = createDatabase(databasePath);
    try {
      const leaderboard = createRepositories(reopened).aggregation.leaderboard(20, 0);
      const example = leaderboard.find((row) => row.name === "Example Ltd");
      assert.equal(example.weight_avg, 7.85, "single weighted holding => its own weight as the average");
      assert.equal(example.weight_min, 7.85);
      assert.equal(example.weight_max, 7.85);

      const unweighted = leaderboard.find((row) => row.name === "No Weight Ltd");
      assert.equal(unweighted.weight_avg, null, "no parsable weight stays null after the backfill");
      assert.equal(unweighted.weight_min, null);
      assert.equal(unweighted.weight_max, null);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

