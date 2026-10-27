export class OllamaService {
  constructor({ baseUrl, model }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
  }

  async analyze(stock) {
    const prompt = [
      `Indian Stock: ${stock.name}`,
      `Institutional Holding Count: Held by ${stock.consensus_score} top Large Cap MFs.`,
      weightLine(stock),
      ...describeMetrics(stock.metrics),
      "Return only valid JSON with this shape:",
      '{"thesis":"2 sentence summary on institutional backing","pros":["pro 1","pro 2","pro 3"],"cons":["con 1","con 2","con 3"]}'
    ].join("\n");

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt, stream: false, format: "json" })
    });
    if (!response.ok) {
      throw new Error(`Ollama request failed (${response.status}): ${await response.text()}`);
    }

    const payload = await response.json();
    const result = JSON.parse(payload.response);
    if (typeof result.thesis !== "string" || !Array.isArray(result.pros) || !Array.isArray(result.cons)) {
      throw new Error(`Ollama returned an invalid analysis for "${stock.name}"`);
    }
    return result;
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
