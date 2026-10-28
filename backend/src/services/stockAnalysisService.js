import { createHash } from "node:crypto";
import { sortPeriods } from "./marketMath.js";

export const PROMPT_VERSION = 2;

export const VERDICTS = Object.freeze({
  notHeld: ["BUY", "IGNORE"],
  held: ["HOLD", "SELL"]
});

const SYSTEM_PROMPT = `You are a careful equity analyst for Indian listed stocks (NSE/BSE), helping one retail investor decide what to do with a single stock.

Evidence you receive (all in DATA; any part may be missing):
1. FUND SIGNAL: how many actively managed mutual funds tracked by the app hold the stock, overall and per SEBI category, from official monthly AMC portfolio disclosures (roughly 4-6 weeks old). Broad holding means professional managers independently backed it; it is not a guarantee (disclosures lag; funds crowd into the same names).
2. PROFILE: quote, valuation and quality ratios (P/E vs industry P/E, P/B, ROE, ROCE, debt/equity, dividend yield), growth rates, pros/cons, technical indicators (RSI, moving averages, MACD, ...) and analyst consensus ratings.
3. FINANCIALS: quarterly and annual P&L, balance sheet, cash flow and ratios, with period-over-period % changes.
4. PRICE: statistics computed from one year of daily prices: returns (1w-1y), distance from the 52-week high/low, 50/200-day moving averages, volume and delivery %, volatility, max drawdown, weekly closes.
5. OWNERSHIP: quarterly promoter / FII / DII / public holding and promoter pledge trend.
6. ANALYST FORECASTS: consensus EPS/revenue/price estimates and how past estimates compared with actuals.
7. MARKET: market-wide FII/DII cash flows and market pulse. Context only: it describes the whole market, not this company.

Reading the data:
- Time series are ordered oldest to newest (maps keyed by period, and "periods" lists). The last entry is the latest.
- Use ONLY the data provided. Never invent or estimate numbers. Every number you cite must appear in DATA.
- If something important is missing or stale (see stale_sections), say so in data_gaps and lower your confidence.

How to weigh it:
- Business quality and trend first: growth of revenue and profit, margins, ROE/ROCE, balance-sheet risk (debt, interest cover), cash flow versus reported profit.
- Valuation relative to the stock's own industry and growth; a cheap stock with falling earnings is not cheap.
- Fund consensus and its breadth; rising institutional (FII/DII) ownership supports the thesis, steady selling weakens it.
- Price and technicals for timing and risk: trend versus 50/200-day averages, distance from highs, volatility, drawdown, delivery %. Do not override weak fundamentals with a good chart.
- Analyst views are one input; analysts are often optimistic and targets move. Note when estimates were missed.
- Red flags: high or rising promoter pledge, a falling promoter stake, negative or falling operating cash flow while profits rise, rising debt, deteriorating asset quality (for lenders).
- Some companies have no promoter group by design (many banks and widely held companies). Zero promoter holding is not a red flag by itself; only a declining promoter stake is.
- Small caps carry extra liquidity, governance and volatility risk; size positions accordingly in what you write.

Output:
- Pick exactly one verdict from the allowed set in the request. Be decisive but honest; "IGNORE" or "SELL" are fine answers.
- price_trend: one or two sentences on price, momentum and technicals. ownership_trend: institutional and promoter holding trend. analyst_view: consensus and forecasts (say "not available" if missing).
- Keep every list item to one short sentence. Write for a smart non-professional.
- This is decision support, not investment advice.`;

/**
 * Lazy LLM analysis for one stock: fund-consensus signal + Tapetide
 * fundamentals → verdict. Runs only when requested, and the result is cached
 * per (stock, held) until its inputs change (new fundamentals, new scrape,
 * different model or prompt), so repeat views cost nothing.
 */
export class StockAnalysisService {
  constructor({ repositories, fundamentalsService, llm, now = Date.now, maxSectionChars = 12000 }) {
    this.repositories = repositories;
    this.fundamentalsService = fundamentalsService;
    this.llm = llm;
    this.now = now;
    this.maxSectionChars = maxSectionChars;
    this.inFlight = new Map();
  }

  async analyze(stockId, { held = false, refresh = false } = {}) {
    const key = `${stockId}|${held}|${refresh}`;
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const promise = this.run(stockId, { held, refresh }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  async run(stockId, { held, refresh }) {
    const stock = this.repositories.stocks.getById(stockId);
    if (!stock) return null;

    // Fundamentals are themselves lazy + cached; a failure there still leaves
    // the fund signal, so the analysis degrades instead of failing.
    let fundamentals = null;
    const errors = [];
    if (this.fundamentalsService) {
      try {
        fundamentals = await this.fundamentalsService.getFundamentals(stockId);
        errors.push(...(fundamentals?.errors ?? []).map((error) => ({ source: "fundamentals", ...error })));
      } catch (error) {
        errors.push({ source: "fundamentals", message: error.message });
      }
    }
    let market = null;
    if (this.fundamentalsService?.getMarketContext) {
      try {
        market = await this.fundamentalsService.getMarketContext();
        errors.push(...(market?.errors ?? []).map((error) => ({ source: "market", ...error })));
      } catch (error) {
        errors.push({ source: "market", message: error.message });
      }
    }
    const fundSignal = fundamentals?.fund_signal ?? this.repositories.aggregation.signalFor(stockId);
    const digest = buildDigest({ stock, fundSignal, fundamentals, market, maxSectionChars: this.maxSectionChars });
    const model = this.llm.describe();
    const inputHash = createHash("sha256")
      .update(JSON.stringify({ digest, held, model, v: PROMPT_VERSION }))
      .digest("hex");

    const cached = this.repositories.analyses.get(stockId, held);
    if (!refresh && cached && cached.input_hash === inputHash) {
      return this.respond({ stock, held, row: cached, cached: true, digest, errors });
    }

    const allowed = held ? VERDICTS.held : VERDICTS.notHeld;
    const result = await this.llm.generateJson({
      system: SYSTEM_PROMPT,
      prompt: buildPrompt({ digest, held, allowed }),
      schema: analysisSchema(allowed),
      schemaName: "stock_analysis"
    });
    const analysis = validateAnalysis(result, allowed);
    const row = this.repositories.analyses.upsert(stockId, held, {
      provider: model.provider,
      model: model.model,
      inputHash,
      result: analysis
    });
    return this.respond({ stock, held, row, cached: false, digest, errors });
  }

  respond({ stock, held, row, cached, digest, errors }) {
    return {
      stock: { id: stock.id, name: stock.name, isin: stock.isin ?? null, symbol: digest.stock.symbol },
      held,
      analysis: row.result,
      model: { provider: row.provider, model: row.model },
      generated_at: row.created_at,
      cached,
      inputs: {
        fund_signal: digest.fund_signal,
        fundamentals_sections: Object.keys(digest.fundamentals),
        market_sections: Object.keys(digest.market ?? {}),
        stale_sections: digest.stale_sections,
        prompt_chars: JSON.stringify(digest).length
      },
      errors,
      disclaimer: "Decision support generated by an AI model from public data. Not investment advice."
    };
  }
}

export function buildPrompt({ digest, held, allowed }) {
  return [
    held
      ? "The investor ALREADY HOLDS this stock. Decide whether to HOLD or SELL."
      : "The investor does NOT hold this stock. Decide whether to BUY or IGNORE.",
    `Allowed verdicts: ${allowed.join(", ")}.`,
    "",
    "DATA (JSON):",
    JSON.stringify(digest)
  ].join("\n");
}

// A compact, deterministic view of everything the model may use:
// - period tables (financials, shareholding) become chronologically ordered
//   `metric → { period: value }` maps, latest N periods only;
// - price history is replaced by statistics computed in code;
// - everything is pruned (nulls, long text) and capped per section.
export const DIGEST_MAX_PERIODS = Object.freeze({ shareholding: 8, financials: 6, default: 8 });

export function buildDigest({ stock, fundSignal, fundamentals, market = null, maxSectionChars = 12000 }) {
  const sections = {};
  const stale = [];
  for (const [name, section] of Object.entries(fundamentals?.fundamentals ?? {})) {
    if (!section?.data && !section?.summary) continue;
    const content = section.summary
      ? limitSeries(section.summary)
      : orderPeriodTables(section.data, DIGEST_MAX_PERIODS[name] ?? DIGEST_MAX_PERIODS.default);
    sections[name] = { as_of: section.fetched_at, data: capSize(prune(content), maxSectionChars) };
    if (section.stale) stale.push(name);
  }
  const marketSections = {};
  for (const [name, section] of Object.entries(market?.sections ?? {})) {
    if (!section?.data) continue;
    marketSections[name] = { as_of: section.fetched_at, data: capSize(prune(orderPeriodTables(section.data, 8)), Math.round(maxSectionChars / 2)) };
    if (section.stale) stale.push(`market.${name}`);
  }
  return {
    stock: {
      name: stock.name,
      isin: stock.isin ?? null,
      symbol: fundamentals?.stock?.symbol ?? stock.symbol ?? null
    },
    fund_signal: fundSignal ? roundDeep(fundSignal) : null,
    fundamentals: sections,
    market: marketSections,
    stale_sections: stale
  };
}

// Tapetide period table: { data: { Metric: { "Jun 2026": v } }, periods, row_order, pct_changes }.
function isPeriodTable(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  if (!node.data || typeof node.data !== "object" || Array.isArray(node.data)) return false;
  if (!Array.isArray(node.periods) && !Array.isArray(node.row_order)) return false;
  return Object.values(node.data).some((value) => value && typeof value === "object" && !Array.isArray(value));
}

function orderedSeries(map, periods) {
  if (!map || typeof map !== "object") return undefined;
  const out = {};
  for (const [metric, values] of Object.entries(map)) {
    if (!values || typeof values !== "object") continue;
    const series = {};
    for (const period of periods) if (values[period] !== undefined && values[period] !== null) series[period] = values[period];
    if (Object.keys(series).length) out[metric] = series;
  }
  return out;
}

/** Recursively rewrite period tables into chronological, trimmed maps; other values pass through. */
export function orderPeriodTables(value, maxPeriods = 8, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => orderPeriodTables(item, maxPeriods, depth + 1));
  if (isPeriodTable(value)) {
    const all = new Set(Array.isArray(value.periods) ? value.periods : []);
    for (const series of Object.values(value.data)) if (series && typeof series === "object") Object.keys(series).forEach((period) => all.add(period));
    const periods = sortPeriods([...all]).slice(-maxPeriods);
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (["data", "periods", "row_order", "pct_changes", "availability"].includes(key)) continue;
      out[key] = typeof entry === "object" ? orderPeriodTables(entry, maxPeriods, depth + 1) : entry;
    }
    out.periods = periods;
    out.data = orderedSeries(value.data, periods);
    const changes = orderedSeries(value.pct_changes, periods);
    if (changes && Object.keys(changes).length) out.pct_changes = changes;
    return out;
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = orderPeriodTables(entry, maxPeriods, depth + 1);
  return out;
}

// Computed summaries: keep the most recent part of any series (prune keeps the head).
function limitSeries(summary) {
  if (!summary || typeof summary !== "object") return summary;
  const out = { ...summary };
  for (const [key, entry] of Object.entries(out)) if (Array.isArray(entry) && entry.length > 16) out[key] = entry.slice(-16);
  return out;
}

function prune(value, depth = 0) {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : undefined;
  if (typeof value === "string") return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  if (Array.isArray(value)) {
    const items = value.slice(0, 16).map((item) => prune(item, depth + 1)).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (typeof value === "object") {
    if (depth > 6) return undefined;
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const pruned = prune(entry, depth + 1);
      if (pruned !== undefined) out[key] = pruned;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

// Drop trailing array items (oldest periods are usually last or first; we keep
// the head) until the section fits; last resort is a truncated string.
function capSize(value, maxChars) {
  if (value === undefined) return null;
  let current = value;
  for (let guard = 0; guard < 50 && JSON.stringify(current).length > maxChars; guard += 1) {
    const shrunk = shrinkLongestArray(current);
    if (!shrunk) break;
    current = shrunk;
  }
  const text = JSON.stringify(current);
  return text.length > maxChars ? `${text.slice(0, maxChars)}…(truncated)` : current;
}

function shrinkLongestArray(root) {
  let best = null;
  const visit = (node, parent, key) => {
    if (Array.isArray(node)) {
      if (node.length > 2 && (!best || node.length > best.node.length)) best = { node, parent, key };
      node.forEach((child, index) => visit(child, node, index));
    } else if (node && typeof node === "object") {
      for (const [childKey, child] of Object.entries(node)) visit(child, node, childKey);
    }
  };
  const copy = structuredClone(root);
  visit(copy, null, null);
  if (!best) return null;
  const trimmed = best.node.slice(0, Math.max(2, Math.ceil(best.node.length * 0.6)));
  if (best.parent === null) return trimmed;
  best.parent[best.key] = trimmed;
  return copy;
}

function roundDeep(value) {
  if (typeof value === "number") return Math.round(value * 100) / 100;
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundDeep(v)]));
  return value;
}

export function analysisSchema(allowed) {
  const list = { type: "array", items: { type: "string" } };
  return {
    type: "object",
    properties: {
      verdict: { type: "string", enum: allowed },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      summary: { type: "string" },
      fund_consensus: { type: "string" },
      valuation: { type: "string" },
      price_trend: { type: "string" },
      ownership_trend: { type: "string" },
      analyst_view: { type: "string" },
      strengths: list,
      risks: list,
      red_flags: list,
      what_would_change_view: list,
      data_gaps: list
    },
    required: [
      "verdict", "confidence", "summary", "fund_consensus", "valuation", "price_trend", "ownership_trend",
      "analyst_view", "strengths", "risks", "red_flags", "what_would_change_view", "data_gaps"
    ],
    additionalProperties: false
  };
}

export function validateAnalysis(result, allowed) {
  if (!result || typeof result !== "object") throw new Error("LLM returned no analysis object");
  const verdict = String(result.verdict ?? "").toUpperCase().trim();
  if (!allowed.includes(verdict)) {
    throw new Error(`LLM returned verdict "${result.verdict}", expected one of ${allowed.join("/")}`);
  }
  const confidence = ["low", "medium", "high"].includes(String(result.confidence).toLowerCase())
    ? String(result.confidence).toLowerCase()
    : "low";
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const list = (value) => (Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 8) : []);
  const summary = text(result.summary);
  if (!summary) throw new Error("LLM analysis is missing a summary");
  return {
    verdict,
    confidence,
    summary,
    fund_consensus: text(result.fund_consensus),
    valuation: text(result.valuation),
    price_trend: text(result.price_trend),
    ownership_trend: text(result.ownership_trend),
    analyst_view: text(result.analyst_view),
    strengths: list(result.strengths),
    risks: list(result.risks),
    red_flags: list(result.red_flags),
    what_would_change_view: list(result.what_would_change_view),
    data_gaps: list(result.data_gaps)
  };
}
