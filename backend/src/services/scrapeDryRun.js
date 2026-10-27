import { withBrowser } from "../scrapers/browser.js";
import { normalizeCategories } from "../scrapers/categoryList.js";

export const DRY_RUN_DEFAULT_LIMIT = 5;
export const DRY_RUN_MAX_LIMIT = 50;

/**
 * Scrape a tiny slice of the real configuration so the XPath/selectors can be
 * validated against the live page without a full, minutes-long scrape:
 * exactly one category → exactly one fund of that category → up to `limit`
 * holdings, each with every data point the parser could read.
 *
 * Deliberately read-only: nothing is written to the database and no scrape job
 * is recorded, so it is safe to run repeatedly while tuning selectors.
 */
export class ScrapeDryRunService {
  // `withBrowser` is injectable so the orchestration can be unit-tested without
  // launching Chromium; production uses the shared browser helper.
  constructor({ configuration, sourceRegistry, withBrowser: runWithBrowser = withBrowser }) {
    this.configuration = configuration;
    this.sourceRegistry = sourceRegistry;
    this.withBrowser = runWithBrowser;
  }

  /** The normalised category list the dry run can sample (drives the client dropdown). */
  categories() {
    return normalizeCategories(this.configuration);
  }

  /** Run one dry run. `category`/`fund` are optional selectors (name or index). */
  async run({ category, fund, limit = DRY_RUN_DEFAULT_LIMIT } = {}) {
    const categories = this.categories();
    const selected = selectCategory(categories, category);
    const maxHoldings = clampLimit(limit);

    const adapter = this.sourceRegistry.resolve(selected.url);
    const categoryConfiguration = {
      ...this.configuration,
      category_url: selected.url,
      category_xpath: selected.xpath
    };

    return this.withBrowser(this.configuration, async (page) => {
      const funds = await adapter.discoverFunds(page, categoryConfiguration);
      const fundIndex = selectFundIndex(funds, fund);
      if (fundIndex === -1) {
        return {
          category: { name: selected.name, url: selected.url },
          fund: null,
          limit: maxHoldings,
          funds_found: funds.length,
          holdings_found: 0,
          holdings: [],
          diagnostics: [`No fund matched ${describeFundSelector(fund)} among ${funds.length} discovered.`]
        };
      }

      const target = funds[fundIndex];
      const holdings = await adapter.scrapeFundHoldings(
        page,
        target.url,
        categoryConfiguration
      );
      const listed = holdings.slice(0, maxHoldings);
      const diagnostics = buildDiagnostics(holdings, maxHoldings);

      // Follow each listed holding to its own stock detail page so the dry run
      // surfaces the full metric set (price, ratios, financials, shareholding,
      // peers) exactly as the full scrape will persist it — not just the
      // fund-level holdings row. Read-only; failures degrade to nulls.
      for (const holding of listed) {
        if (!holding.url) {
          holding.metrics = null;
          continue;
        }
        try {
          const extracted = await adapter.scrapeStockMetrics(
            page,
            holding.url,
            categoryConfiguration
          );
          holding.metrics = extracted.metrics;
          holding.metrics_provenance = extracted.provenance;
          if (extracted.diagnostics.length > 0) {
            diagnostics.push(`${holding.name}: ${extracted.diagnostics.join(" ")}`);
          }
        } catch (error) {
          holding.metrics = null;
          diagnostics.push(`${holding.name}: stock page scrape failed (${error.message}).`);
        }
      }

      return {
        category: { name: selected.name, url: selected.url },
        fund: { name: target.name, url: target.url, index: fundIndex },
        limit: maxHoldings,
        funds_found: funds.length,
        holdings_found: holdings.length,
        holdings: listed,
        diagnostics
      };
    });
  }
}

function selectCategory(categories, requested) {
  if (requested === undefined || requested === null || requested === "") {
    return categories[0];
  }
  const index = Number(requested);
  const byIndex =
    Number.isInteger(index) && index >= 0 && index < categories.length ? categories[index] : null;
  if (byIndex) return byIndex;
  const byName = categories.find(
    (entry) => entry.name.toLowerCase() === String(requested).trim().toLowerCase()
  );
  if (byName) return byName;
  throw new Error(
    `Unknown dry-run category "${requested}". Available: ${categories.map((entry) => entry.name).join(", ")}`
  );
}

function selectFundIndex(funds, requested) {
  if (funds.length === 0) return -1;
  if (requested === undefined || requested === null || requested === "") return 0;
  const index = Number(requested);
  if (Number.isInteger(index)) {
    return index >= 0 && index < funds.length ? index : -1;
  }
  const needle = String(requested).trim().toLowerCase();
  return funds.findIndex((entry) => entry.name.toLowerCase().includes(needle));
}

function describeFundSelector(fund) {
  return fund === undefined || fund === null || fund === "" ? "the first fund" : `fund "${fund}"`;
}

function clampLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return DRY_RUN_DEFAULT_LIMIT;
  return Math.min(Math.trunc(value), DRY_RUN_MAX_LIMIT);
}

function buildDiagnostics(holdings, maxHoldings) {
  const diagnostics = [];
  if (holdings.length === 0) {
    diagnostics.push(
      "The holdings XPath matched no rows. Check selectors.mf_detail_page.holding_row on the page."
    );
    return diagnostics;
  }
  if (holdings.length > maxHoldings) {
    diagnostics.push(`Showing the first ${maxHoldings} of ${holdings.length} parsed holding(s).`);
  }
  const missingWeights = holdings.filter((holding) => holding.weightPercentage === null).length;
  if (missingWeights > 0) {
    diagnostics.push(
      `${missingWeights} holding(s) have no parsable weight — check selectors.mf_detail_page.stock_weight.`
    );
  }
  const missingUrls = holdings.filter((holding) => !holding.url).length;
  if (missingUrls > 0) {
    diagnostics.push(
      `${missingUrls} holding(s) have no stock detail URL — check selectors.mf_detail_page.stock_url, so their metrics cannot be fetched.`
    );
  }
  return diagnostics;
}
