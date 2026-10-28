import { TapetideError } from "./tapetideClient.js";

/** Sections fetched from Tapetide and the tool that provides each. */
export const DEFAULT_SECTIONS = Object.freeze({
  profile: { tool: "get_company_profile", args: {} },
  financials: { tool: "get_financials", args: {} },
  shareholding: { tool: "get_shareholding", args: { type: "quarterly" } },
  pledge: { tool: "get_promoter_pledge", args: {} }
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
  constructor({ repositories, client, sections = DEFAULT_SECTIONS, now = Date.now, provider = "tapetide", timezone = DEFAULT_TIMEZONE }) {
    this.repositories = repositories;
    this.client = client;
    this.sections = sections;
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
        result[name] = shape(hit, { cached: true, stale: false });
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
        result[name] = shape(row, { cached: false, stale: false });
      } catch (error) {
        errors.push(describeError(name, error));
        if (hit) result[name] = shape(hit, { cached: true, stale: true });
        // Quota/auth problems will fail every remaining section the same way.
        if (isFatal(error)) {
          for (const rest of wanted.slice(wanted.indexOf(name) + 1)) {
            const restHit = cached.get(rest);
            if (restHit) result[rest] = shape(restHit, { cached: true, stale: !this.fetchedToday(restHit) });
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

function shape(row, { cached, stale }) {
  return {
    data: row.payload,
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

