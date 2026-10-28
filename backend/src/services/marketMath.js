/**
 * Pure helpers that turn provider payloads into compact, correctly ordered
 * numbers for the LLM and the UI. Doing the arithmetic here (instead of
 * asking the model) keeps prompts small and the numbers exact.
 */

// ---------------------------------------------------------------- periods --

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Sortable key for a period label: "Jun 2026" → 2026.06, "2026-09-30" → 2026.09,
 * "FY2025"/"2025" → 2025.12, "TTM" → +∞ (always latest). Unknown → null.
 */
export function periodSortKey(label) {
  const text = String(label ?? "").trim();
  if (/^ttm$/i.test(text)) return Number.POSITIVE_INFINITY;
  let match = text.match(/^([A-Za-z]{3})[a-z]*[\s'-]*(\d{2,4})$/);
  if (match && MONTHS[match[1].toLowerCase()]) {
    const year = Number(match[2].length === 2 ? `20${match[2]}` : match[2]);
    return year + MONTHS[match[1].toLowerCase()] / 100;
  }
  match = text.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (match) return Number(match[1]) + Number(match[2]) / 100;
  match = text.match(/^(?:FY\s*)?(\d{4})$/i);
  if (match) return Number(match[1]) + 0.12;
  return null;
}

export function sortPeriods(labels) {
  const keyed = labels.map((label, index) => ({ label, index, key: periodSortKey(label) }));
  // Unknown labels keep their original relative order, after the known ones.
  return keyed
    .sort((a, b) => {
      if (a.key === null && b.key === null) return a.index - b.index;
      if (a.key === null) return 1;
      if (b.key === null) return -1;
      return a.key - b.key;
    })
    .map((entry) => entry.label);
}

/**
 * Tapetide "period table": `{ data: { Row: { "Jun 2026": 1.2, ... } }, periods?, row_order? }`.
 * Returns `{ periods, rows: { Row: [values aligned to periods] }, row_order }`
 * with periods in chronological order (oldest → newest), keeping the latest
 * `maxPeriods`. `data` maps can arrive unsorted (shareholding does), so the
 * order is always recomputed rather than trusted.
 */
export function normalizePeriodTable(table, { maxPeriods = Infinity, rows: onlyRows = null } = {}) {
  const data = table?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const rowNames = (Array.isArray(table.row_order) ? table.row_order : Object.keys(data)).filter(
    (row) => data[row] && typeof data[row] === "object" && (!onlyRows || onlyRows.includes(row))
  );
  const periodSet = new Set(Array.isArray(table.periods) ? table.periods : []);
  for (const row of rowNames) for (const period of Object.keys(data[row])) periodSet.add(period);
  let periods = sortPeriods([...periodSet]);
  if (periods.length > maxPeriods) periods = periods.slice(-maxPeriods);
  const rows = {};
  for (const row of rowNames) {
    const values = periods.map((period) => toNumber(data[row][period]));
    if (values.some((value) => value !== null)) rows[row] = values;
  }
  return { periods, row_order: Object.keys(rows), rows };
}

// ----------------------------------------------------------------- prices --

const DATE_KEYS = ["date", "Date", "timestamp", "time", "t", "trade_date", "day"];
const CLOSE_KEYS = ["close", "Close", "c", "adj_close", "close_price", "ltp"];
const HIGH_KEYS = ["high", "High", "h"];
const LOW_KEYS = ["low", "Low", "l"];
const VOLUME_KEYS = ["volume", "Volume", "v", "vol", "traded_qty"];
const DELIVERY_KEYS = ["delivery_pct", "delivery_percent", "delivery_percentage", "deliv_per", "delivery", "delivery %", "Delivery %", "dly_pct"];

/** Extract `[{ date, close, high, low, volume, delivery }]` (oldest first) from a price-history payload. */
export function extractPriceRows(payload) {
  const container = unwrapData(payload);
  let rows = findRowArray(container);
  if (!rows) rows = columnarToRows(container);
  if (!rows) return [];
  const parsed = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const date = pickValue(row, DATE_KEYS);
    const close = toNumber(pickValue(row, CLOSE_KEYS));
    if (date === undefined || close === null) continue;
    parsed.push({
      date: String(date).slice(0, 10),
      close,
      high: toNumber(pickValue(row, HIGH_KEYS)),
      low: toNumber(pickValue(row, LOW_KEYS)),
      volume: toNumber(pickValue(row, VOLUME_KEYS)),
      delivery: toNumber(pickValue(row, DELIVERY_KEYS))
    });
  }
  parsed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return parsed;
}

/**
 * Price statistics computed from daily rows: returns over standard windows,
 * distance from the 52-week range, moving averages, volume and delivery
 * trends, annualised volatility and 1-year max drawdown, plus a light weekly
 * series for context. Returns null when there is no usable data.
 */
export function summarizePriceHistory(payload) {
  const rows = extractPriceRows(payload);
  if (rows.length < 2) return null;
  const closes = rows.map((row) => row.close);
  const last = rows.at(-1);
  const lookback = (sessions) => (rows.length > sessions ? closes.at(-1 - sessions) : null);
  const pct = (from, to) => (from && to !== null && from !== 0 ? round(((to - from) / from) * 100) : null);
  const year = rows.slice(-252);
  const highs = year.map((row) => row.high ?? row.close);
  const lows = year.map((row) => row.low ?? row.close);
  const high52 = Math.max(...highs);
  const low52 = Math.min(...lows);
  const sma = (n) => (closes.length >= n ? round(mean(closes.slice(-n))) : null);
  const sma50 = sma(50);
  const sma200 = sma(200);
  const volumes = rows.map((row) => row.volume).filter((value) => value !== null);
  const deliveries = rows.map((row) => row.delivery).filter((value) => value !== null);
  const returns = [];
  for (let i = Math.max(1, closes.length - 252); i < closes.length; i += 1) {
    if (closes[i - 1] > 0 && closes[i] > 0) returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const close of year.map((row) => row.close)) {
    peak = Math.max(peak, close);
    if (peak > 0) maxDrawdown = Math.min(maxDrawdown, (close - peak) / peak);
  }
  const weekly = [];
  for (let i = rows.length - 1; i >= 0 && weekly.length < 26; i -= 5) weekly.unshift({ date: rows[i].date, close: rows[i].close });

  return {
    as_of: last.date,
    sessions: rows.length,
    last_close: last.close,
    return_pct: {
      "1w": pct(lookback(5), last.close),
      "1m": pct(lookback(21), last.close),
      "3m": pct(lookback(63), last.close),
      "6m": pct(lookback(126), last.close),
      "1y": pct(lookback(251) ?? (rows.length >= 200 ? closes[0] : null), last.close)
    },
    high_52w: round(high52),
    low_52w: round(low52),
    pct_below_52w_high: pct(high52, last.close),
    pct_above_52w_low: pct(low52, last.close),
    sma_50: sma50,
    sma_200: sma200,
    pct_vs_sma_50: pct(sma50, last.close),
    pct_vs_sma_200: pct(sma200, last.close),
    sma_50_above_sma_200: sma50 !== null && sma200 !== null ? sma50 > sma200 : null,
    avg_volume_20d: volumes.length >= 20 ? Math.round(mean(volumes.slice(-20))) : null,
    avg_volume_3m: volumes.length >= 63 ? Math.round(mean(volumes.slice(-63))) : null,
    avg_delivery_pct_20d: deliveries.length >= 20 ? round(mean(deliveries.slice(-20))) : null,
    avg_delivery_pct_3m: deliveries.length >= 63 ? round(mean(deliveries.slice(-63))) : null,
    volatility_annualized_pct: returns.length >= 20 ? round(stdev(returns) * Math.sqrt(252) * 100) : null,
    max_drawdown_1y_pct: round(maxDrawdown * 100),
    weekly_closes: weekly
  };
}

// ---------------------------------------------------------------- helpers --

export function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[,%₹\s]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdev(values) {
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / Math.max(1, values.length - 1));
}

function unwrapData(payload) {
  let current = payload;
  for (let depth = 0; depth < 3 && current && typeof current === "object" && !Array.isArray(current) && current.data !== undefined; depth += 1) {
    current = current.data;
  }
  return current;
}

function findRowArray(container) {
  if (Array.isArray(container)) return container;
  if (!container || typeof container !== "object") return null;
  for (const key of ["rows", "prices", "history", "candles", "ohlcv", "series", "items", "data"]) {
    if (Array.isArray(container[key])) return container[key];
  }
  return null;
}

// Columnar: { date: [...], close: [...], volume: [...] } → rows.
function columnarToRows(container) {
  if (!container || typeof container !== "object") return null;
  const dateKey = DATE_KEYS.find((key) => Array.isArray(container[key]));
  const closeKey = CLOSE_KEYS.find((key) => Array.isArray(container[key]));
  if (!dateKey || !closeKey) return null;
  return container[dateKey].map((date, index) => {
    const row = { date };
    for (const [key, values] of Object.entries(container)) {
      if (Array.isArray(values)) row[key] = values[index];
    }
    return row;
  });
}

function pickValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}
