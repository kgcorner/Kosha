/**
 * Pure helpers that turn fundamentals payloads (Tapetide shapes) into chart
 * series. Every helper tolerates missing or unexpected data and returns null
 * rather than throwing, so the page falls back to the raw table view.
 */

export interface PeriodTable {
  /** Oldest → newest. */
  periods: string[];
  /** Metric → values aligned to `periods` (null where a period has no value). */
  rows: Record<string, Array<number | null>>;
}

export interface Tile {
  label: string;
  value: string;
  hint?: string;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** "Jun 2026" → 2026.06, "2026-09-30" → 2026.09, "TTM" → +∞, unknown → null. */
export function periodSortKey(label: string): number | null {
  const text = String(label ?? '').trim();
  if (/^ttm$/i.test(text)) {
    return Number.POSITIVE_INFINITY;
  }
  let match = /^([A-Za-z]{3})[a-z]*[\s'-]*(\d{2,4})$/.exec(text);
  const month = match ? MONTHS[match[1].toLowerCase()] : undefined;
  if (match && month) {
    const year = Number(match[2].length === 2 ? `20${match[2]}` : match[2]);
    return year + month / 100;
  }
  match = /^(\d{4})-(\d{2})/.exec(text);
  if (match) {
    return Number(match[1]) + Number(match[2]) / 100;
  }
  return null;
}

export function sortPeriods(labels: string[]): string[] {
  return labels
    .map((label, index) => ({ label, index, key: periodSortKey(label) }))
    .sort((a, b) => {
      if (a.key === null && b.key === null) return a.index - b.index;
      if (a.key === null) return 1;
      if (b.key === null) return -1;
      return a.key - b.key;
    })
    .map((entry) => entry.label);
}

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const cleaned = String(value).replace(/[,%₹\s]/g, '');
  if (cleaned === '' || cleaned === '-') {
    return null;
  }
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tapetide period table: `{ data: { Metric: { period: value } }, periods?, row_order? }`. */
export function normalizePeriodTable(table: unknown, maxPeriods = Infinity): PeriodTable | null {
  if (!isRecord(table) || !isRecord(table['data'])) {
    return null;
  }
  const data = table['data'] as Record<string, unknown>;
  const order = Array.isArray(table['row_order'])
    ? (table['row_order'] as string[])
    : Object.keys(data);
  const names = order.filter((name) => isRecord(data[name]));
  if (names.length === 0) {
    return null;
  }
  const periodSet = new Set<string>(
    Array.isArray(table['periods']) ? (table['periods'] as string[]) : [],
  );
  for (const name of names) {
    Object.keys(data[name] as Record<string, unknown>).forEach((period) => periodSet.add(period));
  }
  let periods = sortPeriods([...periodSet]);
  if (periods.length > maxPeriods) {
    periods = periods.slice(-maxPeriods);
  }
  const rows: PeriodTable['rows'] = {};
  for (const name of names) {
    const series = data[name] as Record<string, unknown>;
    const values = periods.map((period) => toNumber(series[period]));
    if (values.some((value) => value !== null)) {
      rows[name] = values;
    }
  }
  return Object.keys(rows).length > 0 ? { periods, rows } : null;
}

/** Find a period table inside a section payload: by `section` name (financials) or the first one. */
export function findPeriodTable(payload: unknown, section?: string): unknown {
  const visit = (node: unknown, depth: number): unknown => {
    if (depth > 4 || node === null || typeof node !== 'object') {
      return null;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const record = node as Record<string, unknown>;
    const looksLikeTable =
      isRecord(record['data']) &&
      (Array.isArray(record['periods']) || Array.isArray(record['row_order']));
    if (
      looksLikeTable &&
      (!section || record['section'] === section || record['period_type'] === section)
    ) {
      return record;
    }
    for (const value of Object.values(record)) {
      const found = visit(value, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(payload, 0);
}

/** Trailing simple moving average aligned to `values` (null until `window` points exist). */
export function movingAverage(values: Array<number | null>, window: number): Array<number | null> {
  const out: Array<number | null> = [];
  let sum = 0;
  let count = 0;
  const queue: number[] = [];
  for (const value of values) {
    if (value === null) {
      out.push(null);
      continue;
    }
    queue.push(value);
    sum += value;
    count += 1;
    if (queue.length > window) {
      sum -= queue.shift() as number;
      count -= 1;
    }
    out.push(count === window ? sum / window : null);
  }
  return out;
}

/** Promoter pledge (% of promoter holding) by quarter, oldest → newest. */
export function pledgeSeries(payload: unknown): { periods: string[]; values: number[] } | null {
  const data =
    isRecord(payload) && isRecord(payload['data'])
      ? (payload['data'] as Record<string, unknown>)
      : null;
  const trend =
    data && Array.isArray(data['quarterly_trend']) ? (data['quarterly_trend'] as unknown[]) : null;
  if (!trend) {
    return null;
  }
  const points = trend
    .filter(isRecord)
    .map((row) => ({
      period: String(row['quarter'] ?? ''),
      value: toNumber(row['pct_promoter_holding_pledged']),
    }))
    .filter(
      (point): point is { period: string; value: number } =>
        point.period !== '' && point.value !== null,
    );
  if (points.length === 0) {
    return null;
  }
  const order = sortPeriods(points.map((point) => point.period));
  const byPeriod = new Map(points.map((point) => [point.period, point.value]));
  return { periods: order, values: order.map((period) => byPeriod.get(period) as number) };
}

/** Headline figures from a `get_company_profile` payload. */
export function profileTiles(payload: unknown): Tile[] {
  const data =
    isRecord(payload) && isRecord(payload['data'])
      ? (payload['data'] as Record<string, unknown>)
      : {};
  const f = isRecord(data['fundamentals']) ? (data['fundamentals'] as Record<string, unknown>) : {};
  const pm = isRecord(data['price_metrics'])
    ? (data['price_metrics'] as Record<string, unknown>)
    : {};
  const quote = isRecord(data['quote']) ? (data['quote'] as Record<string, unknown>) : {};
  const number = (...values: unknown[]) =>
    values.map(toNumber).find((value) => value !== null) ?? null;
  const tiles: Tile[] = [];
  const add = (
    label: string,
    value: number | null,
    format: (v: number) => string,
    hint?: string,
  ) => {
    if (value !== null) tiles.push({ label, value: format(value), ...(hint ? { hint } : {}) });
  };
  const change = number(quote['change_pct']);
  add(
    'Price',
    number(pm['price'], quote['price']),
    (v) => `₹${fmt(v)}`,
    change !== null ? `${change >= 0 ? '+' : ''}${fmt(change)}% today` : undefined,
  );
  add(
    'Market cap',
    number(pm['market_cap'], f['market_cap']),
    (v) => `₹${fmt(v, 0)} Cr`,
    typeof f['company_classification'] === 'string'
      ? (f['company_classification'] as string)
      : undefined,
  );
  add('P/E (TTM)', number(pm['pe_ttm'], f['stock_pe']), (v) => fmt(v));
  add('P/B', number(pm['pb'], f['price_to_book']), (v) => fmt(v));
  add('ROE', number(f['roe']), (v) => `${fmt(v)}%`);
  add('ROCE', number(f['roce']), (v) => `${fmt(v)}%`);
  add('Debt / equity', number(f['debt_to_equity']), (v) => fmt(v));
  add('Dividend yield', number(f['dividend_yield']), (v) => `${fmt(v)}%`);
  add('RSI (14d)', number(f['day_rsi14']), (v) => fmt(v, 0), rsiHint(number(f['day_rsi14'])));
  return tiles;
}

/** Current price within its 52-week range (0–100), if the profile has the numbers. */
export function rangePosition(
  payload: unknown,
): { low: number; high: number; price: number; pct: number } | null {
  const data =
    isRecord(payload) && isRecord(payload['data'])
      ? (payload['data'] as Record<string, unknown>)
      : {};
  const f = isRecord(data['fundamentals']) ? (data['fundamentals'] as Record<string, unknown>) : {};
  const pm = isRecord(data['price_metrics'])
    ? (data['price_metrics'] as Record<string, unknown>)
    : {};
  const low = toNumber(pm['low_52w'] ?? f['low_52w']);
  const high = toNumber(pm['high_52w'] ?? f['high_52w']);
  const price = toNumber(pm['price']);
  if (low === null || high === null || price === null || high <= low) {
    return null;
  }
  return {
    low,
    high,
    price,
    pct: Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100)),
  };
}

function rsiHint(rsi: number | null): string | undefined {
  if (rsi === null) return undefined;
  if (rsi >= 70) return 'Overbought zone';
  if (rsi <= 30) return 'Oversold zone';
  return 'Neutral';
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "2026-06-29" → "Jun 2026" (axis ticks); other labels pass through. */
export function monthLabel(label: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(label);
  return match ? `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}` : label;
}

/** "2026-06-29" → "29 Jun 2026" (tooltips); other labels pass through. */
export function dayLabel(label: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(label);
  return match ? `${Number(match[3])} ${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}` : label;
}

/** Indian grouping, at most `digits` decimals. */
export function fmt(value: number, digits = 2): string {
  return value.toLocaleString('en-IN', { maximumFractionDigits: digits });
}

/** Compact axis label: 1.2K, 3.4L, 5.6Cr style is avoided; keeps K/M for axes. */
export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${fmt(value / 1_000_000, 1)}M`;
  if (abs >= 1_000) return `${fmt(value / 1_000, 1)}K`;
  return fmt(value, abs < 10 ? 2 : 1);
}

/** Round axis ticks covering [min, max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0];
  }
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const rough = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value < max + step - step * 1e-9 && ticks.length < 12; value += step) {
    ticks.push(Math.round(value * 1e6) / 1e6);
  }
  return ticks;
}
