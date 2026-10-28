import { TapetideError } from "./tapetideClient.js";
import { extractPriceRows, summarizePriceHistory } from "./marketMath.js";

/**
 * Per-stock sections fetched from Tapetide and the tool that provides each.
 *   profile       quote, valuation & quality ratios, growth, technical
 *                 indicators (RSI, SMA/EMA, MACD, ...) and analyst consensus
 *   financials    quarterly + annual P&L, balance sheet, cash flow, ratios
 *   shareholding  quarterly promoter / FII / DII / public holding
 *   pledge        promoter pledge trend
 *   price_history 1 year of daily OHLCV + delivery % (summarised in code)
 *   forecasts     analyst EPS / revenue / price estimates vs actuals
 */
export const DEFAULT_SECTIONS = Object.freeze({
  profile: { tool: "get_company_profile", args: { include: ["technicals", "ratings"] } },
  financials: { tool: "get_financials", args: {} },
  shareholding: { tool: "get_shareholding", args: { type: "quarterly" } },
  pledge: { tool: "get_promoter_pledge", args: {} },
  price_history: {
    tool: "get_price_history",
    args: { days: 365 },
    summarize: summarizePriceHistory,
    // Compact chart series for clients; the LLM digest uses `summary` only.
    series: (payload) => extractPriceRows(payload).map(({ date, close, volume }) => ({ date, close, volume }))
  },
  forecasts: { tool: "get_forecasts", args: {} }
});

/**
 * Market-wide context, the same for every stock, fetched at most once per day
 * in total (not per stock) and stored in `market_data`.
 *   fii_dii  30 trading days of FII/DII cash flows, aggregates and streaks
 *   pulse    today's FII/DII net flows, Nifty 50 valuation, India VIX
 */
export const MARKET_SECTIONS = Object.freeze({
  fii_dii: { tool: "get_fii_dii_detail", args: {} },
  pulse: { tool: "get_market_pulse", args: {} }
});

export const DEFAULT_TIMEZONE = "Asia/Kolkata";

/**
 * Lazy, on-demand stock fundamentals. Nothing here runs during a scrape:
 * Tapetide is called only when a client asks for one stock's fundamentals.
 *
 * Cache rule: every response is stored in SQLite, and the provider is called
 * for a section only when its stored copy was fetched on an earlier calendar
 * day (in `timezone`, IST by default). So each stock costs at most one external
 * call per section per day, however often it is viewed.
 *
 * If Tapetide fails (quota exhausted, outage, no token) the last stored copy
 * of each section is returned and marked `stale`, alongside an `errors` list;
 * the next view that day tries again.
 */
export class FundamentalsService {
  constructor({ repositories, client, sections = DEFAULT_SECTIONS, marketSections = MARKET_SECTIONS, now = Date.now, provider = "tapetide", timezone = DEFAULT_TIMEZONE }) {
    this.repositories = repositories;
    this.client = client;
    this.sections = sections;
    this.marketSections = marketSections;
    this.now = now;
    this.provider = provider;
    this.timezone = timezone;
    this.dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    this.inFlight = new Map();
  }

  sectionNames() {
    return Object.keys(this.sections);
  }

  /** Returns null when the stock does not exist. */
  async getFundamentals(stockId, { sections = null } = {}) {
    const key = `${stockId}|${(sections ?? []).join(",")}`;
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const promise = this.load(stockId, { sections }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  async load(stockId, { sections }) {
    const stock = this.repositories.stocks.getById(stockId);
    if (!stock) return null;

    const wanted = this.resolveSections(sections);
    const cached = new Map(this.repositories.fundamentals.list(stockId).map((row) => [row.section, row]));
    const result = {};
    const errors = [];
    let symbol = stock.symbol ?? null;

    for (const name of wanted) {
      const definition = this.sections[name];
      const hit = cached.get(name);
      if (hit && this.fetchedToday(hit)) {
        result[name] = shape(hit, { cached: true, stale: false }, definition);
        continue;
      }
      try {
        symbol = symbol ?? (await this.resolveSymbol(stock));
        const data = await this.client.callTool(definition.tool, { ...definition.args, symbol });
        const row = this.repositories.fundamentals.upsert(stock.id, name, {
          provider: this.provider,
          symbol,
          payload: data
        });
        result[name] = shape(row, { cached: false, stale: false }, definition);
      } catch (error) {
        errors.push(describeError(name, error));
        if (hit) result[name] = shape(hit, { cached: true, stale: true }, definition);
        // Quota/auth problems will fail every remaining section the same way.
        if (isFatal(error)) {
          for (const rest of wanted.slice(wanted.indexOf(name) + 1)) {
            const restHit = cached.get(rest);
            if (restHit) result[rest] = shape(restHit, { cached: true, stale: !this.fetchedToday(restHit) }, this.sections[rest]);
          }
          break;
        }
      }
    }

    return {
      stock: { id: stock.id, name: stock.name, isin: stock.isin ?? null, symbol },
      provider: this.provider,
      fund_signal: this.repositories.aggregation.signalFor(stock.id),
      fundamentals: result,
      cache_policy: { rule: "one provider call per stock per section per calendar day", timezone: this.timezone, today: this.dayKey(this.now()) },
      errors
    };
  }

  /**
   * Market-wide context (FII/DII flows, market pulse) under the same
   * once-per-calendar-day rule, shared by every stock. Never throws: failures
   * fall back to the last stored copy and are listed in `errors`.
   */
  async getMarketContext() {
    if (this.marketInFlight) return this.marketInFlight;
    this.marketInFlight = this.loadMarket().finally(() => {
      this.marketInFlight = null;
    });
    return this.marketInFlight;
  }

  async loadMarket() {
    const sections = {};
    const errors = [];
    for (const [name, definition] of Object.entries(this.marketSections)) {
      const hit = this.repositories.market.get(name);
      if (hit && this.fetchedToday(hit)) {
        sections[name] = shape(hit, { cached: true, stale: false });
        continue;
      }
      try {
        const data = await this.client.callTool(definition.tool, { ...definition.args });
        sections[name] = shape(this.repositories.market.upsert(name, { provider: this.provider, payload: data }), { cached: false, stale: false });
      } catch (error) {
        errors.push(describeError(name, error));
        if (hit) sections[name] = shape(hit, { cached: true, stale: true });
        if (isFatal(error)) {
          for (const rest of Object.keys(this.marketSections).filter((key) => !(key in sections) && key !== name)) {
            const restHit = this.repositories.market.get(rest);
            if (restHit) sections[rest] = shape(restHit, { cached: true, stale: !this.fetchedToday(restHit) });
          }
          break;
        }
      }
    }
    return { provider: this.provider, sections, errors };
  }

  resolveSections(requested) {
    if (!requested || requested.length === 0) return this.sectionNames();
    const unknown = requested.filter((name) => !this.sections[name]);
    if (unknown.length > 0) {
      throw new Error(`Unknown fundamentals section(s): ${unknown.join(", ")}. Available: ${this.sectionNames().join(", ")}`);
    }
    return requested;
  }

  // SQLite stores UTC "YYYY-MM-DD HH:MM:SS"; compare calendar days in the
  // configured timezone so "today" matches the user's day, not UTC's.
  fetchedToday(row) {
    const fetchedAt = Date.parse(`${String(row.fetched_at ?? "").replace(" ", "T")}${row.fetched_at?.endsWith("Z") ? "" : "Z"}`);
    if (!Number.isFinite(fetchedAt)) return false;
    return this.dayKey(fetchedAt) === this.dayKey(this.now());
  }

  dayKey(epochMs) {
    return this.dayFormat.format(new Date(epochMs));
  }

  // ISIN is unambiguous; Tapetide's search accepts it. Fall back to the name
  // for stocks from name-only sources. The symbol is cached on the stock row.
  async resolveSymbol(stock) {
    const queries = [stock.isin, stock.name].filter(Boolean);
    for (const query of queries) {
      const payload = await this.client.callTool("search_stocks", { query, limit: 5 });
      const match = pickMatch(extractList(payload), stock.isin);
      if (match?.symbol) {
        this.repositories.stocks.setSymbol(stock.id, match.symbol);
        return match.symbol;
      }
    }
    throw new TapetideError(`No Tapetide symbol found for "${stock.name}"${stock.isin ? ` (${stock.isin})` : ""}`, {
      code: "symbol_not_found"
    });
  }
}

// `summary` carries numbers computed in code from the raw payload (e.g. price
// statistics), so clients and the LLM don't have to derive them.
function shape(row, { cached, stale }, definition = null) {
  let summary;
  if (definition?.summarize) {
    try {
      summary = definition.summarize(row.payload) ?? null;
    } catch {
      summary = null;
    }
  }
  let series;
  if (definition?.series) {
    try {
      series = definition.series(row.payload) ?? [];
    } catch {
      series = [];
    }
  }
  return {
    data: row.payload,
    ...(summary !== undefined ? { summary } : {}),
    ...(series !== undefined ? { series } : {}),
    fetched_at: row.fetched_at,
    provider: row.provider,
    cached,
    stale
  };
}

function extractList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["results", "stocks", "data", "matches", "items"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function pickMatch(results, isin) {
  if (results.length === 0) return null;
  if (isin) {
    const exact = results.find((row) => String(row.isin ?? row.isin_code ?? "").toUpperCase() === isin.toUpperCase());
    if (exact) return exact;
    // Search by ISIN returned rows without ISIN fields: trust the top hit.
    if (results.every((row) => !row.isin && !row.isin_code)) return results[0];
    return null;
  }
  return results[0];
}

function isFatal(error) {
  return error instanceof TapetideError &&
    ["rate_limited", "not_configured", "auth_failed", "symbol_not_found", "unreachable"].includes(error.code);
}

function describeError(section, error) {
  return {
    section,
    code: error.code ?? null,
    message: error.message,
    ...(error.retryAfterSeconds ? { retry_after_seconds: error.retryAfterSeconds } : {})
  };
}

