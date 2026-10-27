import { SourceAdapter } from "./sourceAdapter.js";

/**
 * Source adapter backed by the MFData.in REST API (https://mfdata.in/docs)
 * instead of scraping HTML.
 *
 * - discoverFunds: `GET {category_url}` where the category URL is a schemes
 *   query, e.g. `https://mfdata.in/api/v1/schemes?category=Small%20Cap&plan_type=direct`.
 *   Scheme variants (Direct/Regular, Growth/IDCW) are collapsed to one entry per
 *   scheme *family*, because every variant holds the same portfolio.
 * - scrapeFundHoldings: `GET /api/v1/families/{family_id}/holdings?holding_type=equity`
 *   (plus `month=YYYY-MM` when `mfdata.month` is configured).
 *
 * The `page` argument is part of the SourceAdapter contract but unused here:
 * nothing is rendered, so the adapter only needs `fetch`.
 *
 * MFData.in's response envelope is not formally specified, so the parsers below
 * accept the shapes seen in its docs (`data.equity`, `data.equity_holdings`,
 * bare arrays, paginated `data.items`/`results`) and several field spellings.
 * Everything tunable lives under `configuration.mfdata` (see `DEFAULTS`).
 */
export class MfdataAdapter extends SourceAdapter {
  constructor(homepage, { fetch: fetchImpl = globalThis.fetch, sleep = defaultSleep } = {}) {
    super();
    this.sourceName = "mfdata";
    this.requiresBrowser = false;
    this.homepage = new URL(homepage);
    this.fetch = fetchImpl;
    this.sleep = sleep;
  }

  supports(url) {
    try {
      const candidate = new URL(url);
      return candidate.protocol === this.homepage.protocol &&
        candidate.hostname === this.homepage.hostname;
    } catch {
      return false;
    }
  }

  async discoverFunds(_page, configuration) {
    const options = resolveOptions(configuration);
    const schemes = await this.fetchAllPages(configuration.category_url, options);
    console.log(`[mfdata:discover] ${configuration.category_url} -> ${schemes.length} scheme variant(s)`);

    const exclude = options.exclude_name_pattern
      ? new RegExp(options.exclude_name_pattern, "i")
      : null;
    const families = new Map();
    let excluded = 0;
    let withoutFamily = 0;

    for (const scheme of schemes) {
      const familyId = pick(scheme, ["family_id", "familyId", "family.id", "family.family_id"]);
      const name = cleanFundName(
        pick(scheme, ["family_name", "familyName", "family.family_name", "family.name"]) ??
        pick(scheme, ["scheme_name", "schemeName", "name"])
      );
      if (familyId === null || familyId === undefined || !name) {
        withoutFamily += 1;
        continue;
      }
      if (exclude && exclude.test(name)) {
        excluded += 1;
        continue;
      }
      if (!families.has(String(familyId))) {
        families.set(String(familyId), {
          name,
          url: this.holdingsUrl(familyId).href
        });
      }
    }

    if (excluded > 0) {
      console.log(`[mfdata:discover] excluded ${excluded} variant(s) matching /${options.exclude_name_pattern}/i`);
    }
    if (withoutFamily > 0) {
      console.warn(`[mfdata:discover] skipped ${withoutFamily} variant(s) with no family_id or name`);
    }
    return [...families.values()];
  }

  async scrapeFundHoldings(_page, url, configuration) {
    const options = resolveOptions(configuration);
    const target = new URL(url);
    if (options.holding_type && !target.searchParams.has("holding_type")) {
      target.searchParams.set("holding_type", options.holding_type);
    }
    if (options.month && !target.searchParams.has("month")) {
      target.searchParams.set("month", options.month);
    }

    const body = await this.getJson(target.href, options);
    const data = unwrap(body);
    const month = pick(data, ["month", "as_of", "portfolio_date"]) ?? null;
    const rows = extractEquityRows(data);

    const holdings = [];
    for (const row of rows) {
      const name = normaliseText(pick(row, ["name", "stock_name", "company_name", "company", "security_name"]));
      if (!name) continue;
      holdings.push({
        name,
        sector: normaliseText(pick(row, ["sector", "industry", "sector_name"])),
        instrument: normaliseText(pick(row, ["instrument", "instrument_type", "asset_type", "holding_type"])) ?? "Equity",
        weightPercentage: toNumber(pick(row, [
          "weight_pct", "weight_percentage", "weight", "percentage", "pct_of_aum", "portfolio_weight", "corpus_per"
        ])),
        // MFData.in has no per-stock detail page; fundamentals come from a
        // separate provider, so there is no URL for the stock-metrics pass.
        url: null,
        isin: normaliseText(pick(row, ["isin", "isin_code", "stock_isin"])),
        quantity: toNumber(pick(row, ["quantity", "qty", "shares"])),
        marketValue: toNumber(pick(row, ["market_value", "market_value_cr", "value", "mv"])),
        monthChange: pick(row, ["mom_change", "change", "qty_change", "change_qty"]) ?? null,
        month
      });
    }

    if (holdings.length === 0) {
      console.warn(`[mfdata:holdings] 0 equity holdings for ${target.href} (response keys: ${describeKeys(data)})`);
    } else {
      console.log(`[mfdata:holdings] ${target.href} -> ${holdings.length} holding(s)${month ? ` as of ${month}` : ""}`);
    }
    return holdings;
  }

  // Holdings carry no stock URL, so the stock scraper never calls this; it is
  // implemented to keep the adapter a drop-in for the dry run and future callers.
  async scrapeStockMetrics(_page, url) {
    return {
      url,
      name: null,
      metrics: {},
      provenance: {},
      payload: {},
      diagnostics: ["MFData.in does not provide per-stock fundamentals; use a fundamentals provider."]
    };
  }

  async dumpDebug(_page, context) {
    console.warn(`[mfdata:${context}] no page to dump (API source)`);
  }

  holdingsUrl(familyId) {
    return new URL(`/api/v1/families/${encodeURIComponent(familyId)}/holdings`, this.homepage);
  }

  // Follow pagination until the API stops returning a next page. Supports a
  // `next` link, or `page`/`total_pages`, or `offset`/`limit`/`total`.
  async fetchAllPages(url, options) {
    const items = [];
    let next = url;
    for (let pageNumber = 1; next && pageNumber <= options.max_pages; pageNumber += 1) {
      const body = await this.getJson(next, options);
      const batch = extractList(body);
      items.push(...batch);
      next = nextPageUrl(next, body, batch.length);
    }
    return items;
  }

  async getJson(url, options) {
    for (let attempt = 0; ; attempt += 1) {
      if (options.request_delay_ms > 0) await this.sleep(options.request_delay_ms);
      const response = await this.fetch(url, {
        headers: { accept: "application/json", "user-agent": options.user_agent },
        signal: AbortSignal.timeout(options.timeout_ms)
      });

      if (response.status === 429 && attempt < options.max_retries) {
        const waitMs = retryAfterMs(response.headers) ?? options.retry_backoff_ms * (attempt + 1);
        console.warn(`[mfdata] 429 on ${url}; retrying in ${waitMs}ms (attempt ${attempt + 1}/${options.max_retries})`);
        await this.sleep(waitMs);
        continue;
      }
      if (response.status >= 500 && attempt < options.max_retries) {
        await this.sleep(options.retry_backoff_ms * (attempt + 1));
        continue;
      }
      if (!response.ok) {
        throw new Error(`MFData.in request failed: HTTP ${response.status} for ${url}`);
      }

      const remainingHeader = response.headers?.get?.("x-ratelimit-remaining");
      const remaining = remainingHeader === null || remainingHeader === undefined || remainingHeader === ""
        ? Number.NaN
        : Number(remainingHeader);
      if (Number.isFinite(remaining) && remaining <= 0) {
        const waitMs = retryAfterMs(response.headers) ?? options.retry_backoff_ms;
        console.warn(`[mfdata] rate limit exhausted; pausing ${waitMs}ms`);
        await this.sleep(waitMs);
      }

      const body = await response.json();
      if (body && typeof body === "object" && body.status && body.status !== "success" && !Array.isArray(body)) {
        throw new Error(`MFData.in returned status "${body.status}" for ${url}: ${body.message ?? body.error ?? ""}`.trim());
      }
      return body;
    }
  }
}

export const DEFAULTS = Object.freeze({
  // Index funds, ETFs and FoFs all hold the same index constituents and would
  // swamp a "what do fund managers pick" consensus ranking.
  exclude_name_pattern: "\\b(index|etf|nifty|sensex|fund of funds?|fof)\\b",
  holding_type: "equity",
  month: null,
  timeout_ms: 30000,
  request_delay_ms: 250,
  max_retries: 3,
  retry_backoff_ms: 2000,
  max_pages: 50,
  user_agent: "kosha/1.0 (+https://github.com/kgcorner/kosha)"
});

function resolveOptions(configuration) {
  return { ...DEFAULTS, ...(configuration?.mfdata ?? {}) };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Read the first present value among dotted paths.
function pick(object, paths) {
  if (!object || typeof object !== "object") return undefined;
  for (const path of paths) {
    let value = object;
    for (const key of path.split(".")) {
      value = value === null || value === undefined ? undefined : value[key];
    }
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function unwrap(body) {
  return body && typeof body === "object" && !Array.isArray(body) && body.data !== undefined
    ? body.data
    : body;
}

function extractList(body) {
  const data = unwrap(body);
  if (Array.isArray(data)) return data;
  const list = pick(data, ["items", "results", "schemes", "funds", "families"]);
  return Array.isArray(list) ? list : [];
}

function extractEquityRows(data) {
  if (Array.isArray(data)) return data;
  const direct = pick(data, ["equity", "equity_holdings", "holdings.equity"]);
  if (Array.isArray(direct)) return direct;
  const mixed = pick(data, ["holdings", "items"]);
  if (Array.isArray(mixed)) {
    return mixed.filter((row) => {
      const type = String(pick(row, ["holding_type", "type", "asset_type"]) ?? "equity").toLowerCase();
      return type.includes("equity") || type.includes("stock");
    });
  }
  return [];
}

function nextPageUrl(currentUrl, body, batchSize) {
  if (batchSize === 0) return null;
  const meta = body && typeof body === "object" ? { ...body, ...(body.meta ?? {}), ...(body.pagination ?? {}) } : {};
  if (typeof meta.next === "string" && meta.next) return new URL(meta.next, currentUrl).href;
  if (meta.next === null || meta.has_more === false) return null;

  const url = new URL(currentUrl);
  const page = Number(meta.page);
  const totalPages = Number(meta.total_pages ?? meta.pages);
  if (Number.isFinite(page) && Number.isFinite(totalPages)) {
    if (page >= totalPages) return null;
    url.searchParams.set("page", String(page + 1));
    return url.href;
  }
  const offset = Number(meta.offset);
  const total = Number(meta.total ?? meta.count);
  if (Number.isFinite(offset) && Number.isFinite(total)) {
    const nextOffset = offset + batchSize;
    if (nextOffset >= total) return null;
    url.searchParams.set("offset", String(nextOffset));
    return url.href;
  }
  return null;
}

function retryAfterMs(headers) {
  const value = headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function normaliseText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

// "Quant Small Cap Fund - Direct Plan - Growth" -> "Quant Small Cap Fund"
function cleanFundName(value) {
  const text = normaliseText(value);
  if (!text) return null;
  return text
    .replace(/\s*[-–(]\s*(direct|regular)\b.*$/i, "")
    .replace(/\s*[-–]\s*(growth|idcw|dividend)\b.*$/i, "")
    .trim() || text;
}

function describeKeys(data) {
  if (Array.isArray(data)) return `array(${data.length})`;
  return data && typeof data === "object" ? Object.keys(data).join(", ") || "(none)" : typeof data;
}
