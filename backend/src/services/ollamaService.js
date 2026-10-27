/**
 * Short scrape-time thesis (thesis/pros/cons) for the top-ranked stocks, used
 * by AggregationService when `ai.enabled` is true. The model call goes through
 * the shared OpenAI-compatible LLM provider (OpenRouter, LM Studio, Ollama); the
 * legacy Ollama `/api/generate` call is kept only when no provider is passed.
 */
const THESIS_SCHEMA = {
  type: "object",
  properties: {
    thesis: { type: "string" },
    pros: { type: "array", items: { type: "string" } },
    cons: { type: "array", items: { type: "string" } }
  },
  required: ["thesis", "pros", "cons"],
  additionalProperties: false
};

export class OllamaService {
  constructor({ baseUrl, model, provider = null } = {}) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, "") : null;
    this.model = model;
    this.provider = provider;
  }

  async analyze(stock) {
    const prompt = [
      `Indian Stock: ${stock.name}`,
      `Institutional Holding Count: Held by ${stock.consensus_score} of the actively managed mutual funds tracked.`,
      weightLine(stock),
      ...describeMetrics(stock.metrics),
      "Use only the data above. Return only valid JSON with this shape:",
      '{"thesis":"2 sentence summary on institutional backing","pros":["pro 1","pro 2","pro 3"],"cons":["con 1","con 2","con 3"]}'
    ].join("\n");

    const result = this.provider
      ? await this.provider.generateJson({
        system: "You are a concise equity analyst for Indian stocks. Never invent numbers.",
        prompt,
        schema: THESIS_SCHEMA,
        schemaName: "stock_thesis"
      })
      : await this.legacyOllama(prompt);
    if (typeof result.thesis !== "string" || !Array.isArray(result.pros) || !Array.isArray(result.cons)) {
      throw new Error(`LLM returned an invalid analysis for "${stock.name}"`);
    }
    return result;
  }

  async legacyOllama(prompt) {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt, stream: false, format: "json" })
    });
    if (!response.ok) {
      throw new Error(`Ollama request failed (${response.status}): ${await response.text()}`);
    }
    const payload = await response.json();
    return JSON.parse(payload.response);
  }
}

// Describe a stock's institutional weight as the per-fund average and range.
// The summed weight is deliberately not sent: a stock held by many funds sums
// to a nonsensical "200%"-style figure that would mislead the model.
function weightLine(stock) {
  if (stock.weight_avg === null || stock.weight_avg === undefined) {
    return "Allocation Weight: not published by the source.";
  }
  const avg = round(stock.weight_avg);
  if (stock.weight_min !== null && stock.weight_max !== null && stock.weight_min !== stock.weight_max) {
    return (
      `Allocation Weight: avg ${avg}% per holding fund ` +
      `(range ${round(stock.weight_min)}–${round(stock.weight_max)}% across ${stock.consensus_score} funds).`
    );
  }
  return `Allocation Weight: ${avg}% per holding fund.`;
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

// Flatten the scraped stock-page metrics into prompt lines so the LLM reasons
// over real fundamentals (price, valuation, shareholding ...) rather than just
// fund membership. `metrics` is the JSON blob from `stock_metrics`.
function describeMetrics(metrics) {
  if (!metrics || typeof metrics !== "object") return [];
  const lines = [];
  for (const [group, fields] of Object.entries(metrics)) {
    if (!fields || typeof fields !== "object") continue;
    for (const [key, value] of Object.entries(fields)) {
      const rendered = renderValue(value);
      if (rendered) lines.push(`${humanize(group)} — ${humanize(key)}: ${rendered}`);
    }
  }
  return lines.length > 0 ? ["Fundamentals:", ...lines] : [];
}

function renderValue(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length > 0 ? value.map((entry) => renderValue(entry)).filter(Boolean).join("; ") : null;
  if (typeof value === "object") {
    const parts = Object.entries(value)
      .map(([key, entry]) => {
        const rendered = renderValue(entry);
        return rendered ? `${humanize(key)}=${rendered}` : null;
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return String(value);
}

function humanize(key) {
  return String(key).replace(/_/g, " ");
}
