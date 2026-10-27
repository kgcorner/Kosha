import { createHash } from "node:crypto";

export const PROMPT_VERSION = 1;

export const VERDICTS = Object.freeze({
  notHeld: ["BUY", "IGNORE"],
  held: ["HOLD", "SELL"]
});

const SYSTEM_PROMPT = `You are a careful equity analyst for Indian listed stocks (NSE/BSE), helping one retail investor decide what to do with a single stock.

You receive two kinds of evidence:
1. FUND SIGNAL: how many actively managed mutual funds tracked by the app hold the stock, overall and per SEBI category (from official monthly AMC portfolio disclosures, roughly 4-6 weeks old). Many funds holding it means professional fund managers have independently backed it. It is not a guarantee: disclosures lag, and funds can be crowded into the same names.
2. FUNDAMENTALS: company profile (price, valuation and quality ratios), financial statements, quarterly shareholding and promoter pledge, from a market-data provider.

Rules:
- Use ONLY the data provided. Never invent or estimate numbers that are not in the data. When you cite a number, it must appear in the data.
- If data is missing or stale, say so in data_gaps and lower your confidence.
- Weigh: fund-manager consensus and its breadth; valuation versus the industry/sector; growth trend of revenue and profit; profitability (ROE/ROCE, margins); balance-sheet risk (debt, interest cover); cash flow versus reported profit; promoter holding trend and pledging; and small-cap specific risks (liquidity, governance, volatility) when relevant.
- A high or rising promoter pledge, falling promoter stake, or negative operating cash flow with rising profits are red flags.
- Pick exactly one verdict from the allowed set given in the request. Be decisive but honest; "IGNORE" or "SELL" are fine answers.
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
    const fundSignal = fundamentals?.fund_signal ?? this.repositories.aggregation.signalFor(stockId);
    const digest = buildDigest({ stock, fundSignal, fundamentals, maxSectionChars: this.maxSectionChars });
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
        stale_sections: digest.stale_sections
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

// A compact, deterministic view of everything the model may use. Large
// provider payloads are pruned (nulls, long text) and capped per section so
// the prompt stays small enough for local models and cheap for hosted ones.
export function buildDigest({ stock, fundSignal, fundamentals, maxSectionChars = 12000 }) {
  const sections = {};
  const stale = [];
  for (const [name, section] of Object.entries(fundamentals?.fundamentals ?? {})) {
    if (!section?.data) continue;
    sections[name] = { as_of: section.fetched_at, data: capSize(prune(section.data), maxSectionChars) };
    if (section.stale) stale.push(name);
  }
  return {
    stock: {
      name: stock.name,
      isin: stock.isin ?? null,
      symbol: fundamentals?.stock?.symbol ?? stock.symbol ?? null
    },
    fund_signal: fundSignal ? roundDeep(fundSignal) : null,
    fundamentals: sections,
    stale_sections: stale
  };
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
      strengths: list,
      risks: list,
      red_flags: list,
      what_would_change_view: list,
      data_gaps: list
    },
    required: ["verdict", "confidence", "summary", "fund_consensus", "valuation", "strengths", "risks", "red_flags", "what_would_change_view", "data_gaps"],
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
    strengths: list(result.strengths),
    risks: list(result.risks),
    red_flags: list(result.red_flags),
    what_would_change_view: list(result.what_would_change_view),
    data_gaps: list(result.data_gaps)
  };
}
