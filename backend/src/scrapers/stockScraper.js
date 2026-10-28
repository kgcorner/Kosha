import { withBrowser, withPageIfNeeded } from "./browser.js";

export class StockScraper {
  // `withBrowser` is injectable so the orchestration can be unit-tested without
  // launching Chromium; production uses the shared browser helper.
  constructor({ configuration, sourceRegistry, repositories, withBrowser: runWithBrowser = withBrowser }) {
    this.configuration = configuration;
    this.sourceRegistry = sourceRegistry;
    this.repositories = repositories;
    this.withBrowser = runWithBrowser;
  }

  async run(funds) {
    const adapter = this.sourceRegistry.resolve(this.sourceRegistry.defaultUrl);
    const stocks = new Map();
    // Metrics count is assigned inside the browser callback, so declare it here.
    let enriched = 0;

    const needsBrowser = adapter.requiresBrowser !== false;
    await withPageIfNeeded(needsBrowser, this.configuration, async (page) => {
      for (const fund of funds) {
        const holdings = await adapter.scrapeFundHoldings(
          page,
          fund.url,
          this.configuration
        );
        this.repositories.holdings.replaceFundHoldings(fund.id, holdings);
        for (const holding of holdings) {
          const key = holding.isin ?? holding.name;
          const existing = stocks.get(key);
          if (!existing) {
            stocks.set(key, { name: holding.name, url: holding.url ?? null, isin: holding.isin ?? null });
          } else if (!existing.url && holding.url) {
            // A later fund page may resolve the detail URL an earlier one missed.
            existing.url = holding.url;
          }
        }
        console.log(`[scrape:stocks] "${fund.name}" -> ${holdings.length} holding(s)`);
      }

      // Second pass: visit every unique stock's own detail page and capture the
      // full configured metric set (price, ratios, financials, shareholding,
      // peers) so LLM analysis has real fundamentals, not just fund membership.
      const targets = limitStocks([...stocks.values()], this.configuration);
      const withoutUrl = needsBrowser ? targets.filter((stock) => !stock.url).length : 0;
      if (withoutUrl > 0) {
        console.warn(
          `[scrape:stocks] ${withoutUrl} stock(s) have no detail URL — check selectors.mf_detail_page.stock_url`
        );
      }

      for (const stock of targets) {
        if (!stock.url) continue;
        try {
          const extracted = await adapter.scrapeStockMetrics(page, stock.url, this.configuration);
          const stockId = this.repositories.holdings.upsertStock({
            name: stock.name,
            url: stock.url,
            isin: stock.isin
          });
          this.repositories.stockMetrics.upsert(stockId, {
            url: stock.url,
            title: extracted.name,
            metrics: extracted.metrics,
            provenance: extracted.provenance,
            raw: extracted.payload
          });
          enriched += 1;
        } catch (error) {
          // One dead stock page must not abort the whole scrape.
          console.warn(`[scrape:stocks] metrics for "${stock.name}" failed:`, error.message);
        }
      }
    }, this.withBrowser);

    console.log(
      `[scrape:stocks] ${stocks.size} unique stock(s), ${enriched} with metrics captured`
    );
    return { stocks: stocks.size, stock_metrics: enriched };
  }
}

// Bound how many stock pages one scrape visits. `scrape.stock_limit` of 0 (the
// default) means every collected stock.
function limitStocks(stocks, configuration) {
  const limit = configuration.scrape?.stock_limit ?? 0;
  return limit > 0 ? stocks.slice(0, limit) : stocks;
}
