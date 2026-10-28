import { SourceAdapter } from "./sourceAdapter.js";

/**
 * Source adapter backed by the open fund-disclosures dataset: AMC statutory
 * monthly portfolio disclosures, parsed and published as static JSON in the
 * public GitHub repo `kushagra-agarwal-a/fund-holdings-data`
 * (parser: https://github.com/subscriptionmanager26-png/fund-disclosures, MIT).
 *
 * Read path (no API key, served by GitHub/jsDelivr):
 *   meta.json                         → pinned commit + CDN URL templates
 *   catalog/amfi-lookup.json          → every AMFI scheme with category,
 *                                       portfolio_id and available_as_of dates
 *   portfolios/asof/{as_of}/{id}.json → one parsed portfolio
 *
 * Category URLs look like
 *   https://cdn.jsdelivr.net/gh/kushagra-agarwal-a/fund-holdings-data/catalog?sub=Small%20Cap%20Fund
 * where each `sub` is an AMFI sub-category ("Small Cap Fund", "ELSS", ...).
 * Several `sub` params may be given (e.g. Value Fund + Contra Fund).
 *
 * Fund URLs are stable per portfolio (no date in them), so the same fund row is
 * reused month after month; the as-of date is resolved from the catalog when
 * holdings are fetched (latest, or `fund_disclosures.as_of` when pinned).
 */
export const DATA_REPO = "kushagra-agarwal-a/fund-holdings-data";
export const DEFAULT_HOMEPAGE = `https://cdn.jsdelivr.net/gh/${DATA_REPO}/`;

export const DEFAULTS = Object.freeze({
  meta_url: `https://raw.githubusercontent.com/${DATA_REPO}/main/meta.json`,
  // Index funds / ETFs / FoFs all hold index constituents and would swamp a
  // "what do fund managers pick" consensus ranking.
  exclude_name_pattern: "\\b(index|etf|nifty|sensex|fund of funds?|fof)\\b",
  as_of: null,
  include_debt: false,
  timeout_ms: 60000,
  request_delay_ms: 50,
  max_retries: 3,
  retry_backoff_ms: 2000,
  catalog_ttl_ms: 60 * 60 * 1000,
  // "cdn" = jsDelivr first with GitHub raw as fallback; "raw" = GitHub raw only.
  mirror: "cdn",
  user_agent: "kosha/1.0 (+https://github.com/kgcorner/kosha)"
});

export class FundDisclosuresAdapter extends SourceAdapter {
  constructor(homepage = DEFAULT_HOMEPAGE, { fetch: fetchImpl = globalThis.fetch, sleep = defaultSleep, now = Date.now } = {}) {
    super();
    this.sourceName = "fund-disclosures";
    this.requiresBrowser = false;
    this.homepage = new URL(homepage);
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.now = now;
    this.cache = null;
  }

  supports(url) {
    try {
      const candidate = new URL(url);
      return candidate.protocol === this.homepage.protocol &&
        candidate.hostname === this.homepage.hostname &&
        candidate.pathname.startsWith(this.homepage.pathname);
    } catch {
      return false;
    }
  }

  async discoverFunds(_page, configuration) {
    const options = resolveOptions(configuration);
    const labels = new URL(configuration.category_url).searchParams.getAll("sub");
    const wanted = labels.map(normaliseCategory);
    if (wanted.length === 0) {
      throw new Error(`fund-disclosures category URL needs at least one ?sub= AMFI sub-category: ${configuration.category_url}`);
    }
    const { meta, catalog } = await this.loadCatalog(options);
    const exclude = options.exclude_name_pattern ? new RegExp(options.exclude_name_pattern, "i") : null;

    const funds = new Map();
    let excluded = 0;
    let noData = 0;
    for (const row of Object.values(catalog)) {
      if (!wanted.includes(normaliseCategory(subCategory(row.category)))) continue;
      const name = row.parent_name || row.name;
      if (!row.portfolio_id || !name) continue;
      if (exclude && exclude.test(name)) {
        excluded += 1;
        continue;
      }
      if (!asOfFor(row, options.as_of)) {
        noData += 1;
        continue;
      }
      if (!funds.has(row.portfolio_id)) {
        funds.set(row.portfolio_id, { name: name.trim(), url: this.fundUrl(row.portfolio_id) });
      }
    }

    console.log(
      `[fund-disclosures:discover] ${labels.join(" + ")} -> ${funds.size} fund(s) ` +
      `(excluded ${excluded} index/ETF variant(s), ${noData} without ${options.as_of ?? "any"} filing; data commit ${meta.commit?.slice(0, 7) ?? "?"}, last sync ${meta.last_asof_sync?.as_of ?? "?"})`
    );
    return [...funds.values()];
  }

  async scrapeFundHoldings(_page, url, configuration) {
    const options = resolveOptions(configuration);
    const portfolioId = this.portfolioIdFromUrl(url);
    const { meta, byPortfolio } = await this.loadCatalog(options);
    const row = byPortfolio.get(portfolioId);
    if (!row) {
      console.warn(`[fund-disclosures:holdings] portfolio ${portfolioId} not in catalog; skipping`);
      return [];
    }
    const asOf = asOfFor(row, options.as_of);
    if (!asOf) {
      console.warn(`[fund-disclosures:holdings] ${row.parent_name}: no filing for ${options.as_of ?? "any date"}`);
      return [];
    }

    const portfolio = await this.getJsonFirst(portfolioUrls(meta, asOf, portfolioId, options), options);
    const types = options.include_debt ? null : new Set(["equity"]);
    const holdings = [];
    for (const item of portfolio.holdings ?? []) {
      if (types && !types.has(item.holding_type)) continue;
      // Some AMCs prefix equity rows ("EQ - NAVIN FLUORINE ..."); ISIN is the
      // identity, the name is only a label.
      const name = clean(item.instrument)?.replace(/^EQ\s*-\s*/i, "") || null;
      if (!name) continue;
      holdings.push({
        name,
        sector: clean(item.industry),
        instrument: item.holding_type ?? "equity",
        weightPercentage: toNumber(item.pct_nav),
        url: null,
        isin: clean(item.isin),
        quantity: toNumber(item.quantity),
        // Disclosures are in INR lakh; expose crore for readability.
        marketValueCr: toNumber(item.market_value) === null ? null : toNumber(item.market_value) / 100,
        asOf
      });
    }
    console.log(`[fund-disclosures:holdings] ${row.parent_name} (${asOf}) -> ${holdings.length} holding(s)`);
    return holdings;
  }

  // Holdings carry no stock URL, so the stock scraper never calls this.
  async scrapeStockMetrics(_page, url) {
    return {
      url,
      name: null,
      metrics: {},
      provenance: {},
      payload: {},
      diagnostics: ["fund-disclosures does not provide per-stock fundamentals; use a fundamentals provider."]
    };
  }

  async dumpDebug(_page, context) {
    console.warn(`[fund-disclosures:${context}] no page to dump (static data source)`);
  }

  fundUrl(portfolioId) {
    return new URL(`portfolios/${encodeURIComponent(portfolioId)}`, this.homepage).href;
  }

  portfolioIdFromUrl(url) {
    const match = new URL(url).pathname.match(/\/portfolios\/([^/]+)\/?$/);
    if (!match) throw new Error(`Not a fund-disclosures portfolio URL: ${url}`);
    return decodeURIComponent(match[1]);
  }

  // meta.json pins a data commit; the ~9 MB catalog is fetched once per commit
  // and reused for an hour so a full scrape downloads it only once.
  async loadCatalog(options) {
    if (this.cache && this.now() - this.cache.loadedAt < options.catalog_ttl_ms) return this.cache;
    const meta = await this.getJson(options.meta_url, options);
    if (this.cache && this.cache.meta.commit && this.cache.meta.commit === meta.commit) {
      this.cache.loadedAt = this.now();
      return this.cache;
    }
    const catalog = await this.getJsonFirst(
      mirrors(meta.cdn_catalog, meta.raw_base && `${meta.raw_base}/catalog/amfi-lookup.json`, options),
      options
    );
    const byPortfolio = new Map();
    for (const row of Object.values(catalog)) {
      if (row?.portfolio_id && !byPortfolio.has(row.portfolio_id)) byPortfolio.set(row.portfolio_id, row);
    }
    console.log(`[fund-disclosures] catalog loaded: ${Object.keys(catalog).length} scheme(s), ${byPortfolio.size} portfolio(s)`);
    this.cache = { meta, catalog, byPortfolio, loadedAt: this.now() };
    return this.cache;
  }

  // Try each mirror in order (jsDelivr CDN, then GitHub raw); a network or HTTP
  // failure on one falls through to the next.
  async getJsonFirst(urls, options) {
    let lastError = null;
    for (const url of urls) {
      try {
        return await this.getJson(url, options);
      } catch (error) {
        lastError = error;
        if (urls.length > 1) console.warn(`[fund-disclosures] ${error.message}; trying next mirror`);
      }
    }
    throw lastError ?? new Error("fund-disclosures: no URL to fetch");
  }

  async getJson(url, options) {
    for (let attempt = 0; ; attempt += 1) {
      if (options.request_delay_ms > 0) await this.sleep(options.request_delay_ms);
      let response;
      try {
        response = await this.fetch(url, {
          headers: { accept: "application/json", "user-agent": options.user_agent },
          signal: AbortSignal.timeout(options.timeout_ms)
        });
      } catch (error) {
        if (attempt < options.max_retries) {
          await this.sleep(options.retry_backoff_ms * (attempt + 1));
          continue;
        }
        throw new Error(`fund-disclosures request failed for ${url}: ${error.message}`);
      }
      if ((response.status === 429 || response.status >= 500) && attempt < options.max_retries) {
        await this.sleep(retryAfterMs(response.headers) ?? options.retry_backoff_ms * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error(`fund-disclosures request failed: HTTP ${response.status} for ${url}`);
      return response.json();
    }
  }
}

function resolveOptions(configuration) {
  return { ...DEFAULTS, ...(configuration?.fund_disclosures ?? {}) };
}

function portfolioUrls(meta, asOf, portfolioId, options) {
  const template = meta.cdn_asof_template ?? meta.cdn_portfolio_template;
  const cdn = template
    ? template.replace("{as_of}", asOf).replace("{portfolio_id}", encodeURIComponent(portfolioId))
    : null;
  const raw = meta.raw_base
    ? `${meta.raw_base}/portfolios/asof/${asOf}/${encodeURIComponent(portfolioId)}.json`
    : null;
  return mirrors(cdn, raw, options);
}

// Ordered, de-duplicated mirror list. `mirror: "raw"` skips jsDelivr entirely.
function mirrors(cdn, raw, options) {
  const ordered = options.mirror === "raw" ? [raw] : [cdn, raw];
  return [...new Set(ordered.filter(Boolean))];
}

// The pinned month when configured (only if that filing exists), else the latest.
function asOfFor(row, pinned) {
  const available = row.available_as_of ?? [];
  if (pinned) return available.includes(pinned) ? pinned : null;
  return row.latest_as_of ?? available[0] ?? null;
}

// "Open Ended Schemes ( Equity Scheme - Small Cap Fund )" -> "Small Cap Fund"
export function subCategory(category) {
  const inner = String(category ?? "").match(/\(\s*(.+?)\s*\)\s*$/)?.[1] ?? String(category ?? "");
  return inner.split(" - ").slice(1).join(" - ").trim() || inner.trim();
}

function normaliseCategory(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9&]+/g, "");
}

function clean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function retryAfterMs(headers) {
  const seconds = Number(headers?.get?.("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
