import test from "node:test";
import assert from "node:assert/strict";
import { normalizePeriodTable, periodSortKey, sortPeriods, summarizePriceHistory, extractPriceRows } from "../src/services/marketMath.js";
import { buildDigest, orderPeriodTables } from "../src/services/stockAnalysisService.js";

test("period labels sort chronologically, TTM last, unknowns after known", () => {
  assert.deepEqual(sortPeriods(["Dec 2022", "Jun 2021", "TTM", "Mar 2022", "2026-06-30", "weird"]), [
    "Jun 2021", "Mar 2022", "Dec 2022", "2026-06-30", "TTM", "weird"
  ]);
  assert.ok(periodSortKey("Sep 2026") > periodSortKey("Jun 2026"));
  assert.equal(periodSortKey("nonsense"), null);
});

// Shape taken from a real Tapetide get_shareholding response (maps arrive unsorted).
const SHAREHOLDING = {
  data: {
    FIIs: { "Dec 2025": 23.49, "Jun 2025": 27.38, "Sep 2026": 17.4, "Mar 2026": 23.37, "Jun 2026": 18.65, "Sep 2025": 25.96 },
    DIIs: { "Dec 2025": 40.24, "Jun 2025": 35.23, "Sep 2026": 47.99, "Mar 2026": 40.74, "Jun 2026": 44.85, "Sep 2025": 36.75 }
  },
  period_type: "quarterly",
  periods: ["Jun 2025", "Sep 2025", "Dec 2025", "Mar 2026", "Jun 2026", "Sep 2026"],
  row_order: ["FIIs", "DIIs"]
};

test("normalizePeriodTable aligns values to chronological periods and trims to the latest N", () => {
  const table = normalizePeriodTable(SHAREHOLDING, { maxPeriods: 4 });
  assert.deepEqual(table.periods, ["Dec 2025", "Mar 2026", "Jun 2026", "Sep 2026"]);
  assert.deepEqual(table.rows.FIIs, [23.49, 23.37, 18.65, 17.4]);
  assert.deepEqual(table.row_order, ["FIIs", "DIIs"]);
});

test("orderPeriodTables rewrites nested period tables into ordered maps and keeps other fields", () => {
  const ordered = orderPeriodTables({ data: [SHAREHOLDING], meta: { count: 1 } }, 3);
  const section = ordered.data[0];
  assert.deepEqual(section.periods, ["Mar 2026", "Jun 2026", "Sep 2026"]);
  assert.deepEqual(Object.keys(section.data.FIIs), ["Mar 2026", "Jun 2026", "Sep 2026"]);
  assert.equal(section.period_type, "quarterly");
  assert.equal("row_order" in section, false);
  assert.deepEqual(ordered.meta, { count: 1 });
});

function dailyRows(count, { start = 100, step = 1, delivery = 40 } = {}) {
  const rows = [];
  const date = new Date(Date.UTC(2025, 9, 1));
  for (let i = 0; i < count; i += 1) {
    date.setUTCDate(date.getUTCDate() + 1);
    rows.push({ date: date.toISOString().slice(0, 10), open: start + i * step, high: start + i * step + 2, low: start + i * step - 2, close: start + i * step, volume: 1000 + i, "delivery %": delivery });
  }
  return rows;
}

test("summarizePriceHistory computes returns, 52w distance, SMAs, delivery and drawdown", () => {
  const summary = summarizePriceHistory({ data: dailyRows(260) });
  assert.equal(summary.sessions, 260);
  assert.equal(summary.last_close, 359);
  assert.equal(summary.return_pct["1m"], Math.round(((359 - 338) / 338) * 10000) / 100);
  assert.equal(summary.high_52w, 361);
  assert.equal(summary.pct_below_52w_high, Math.round(((359 - 361) / 361) * 10000) / 100);
  assert.equal(summary.sma_50, 334.5);
  assert.equal(summary.sma_50_above_sma_200, true);
  assert.equal(summary.avg_delivery_pct_20d, 40);
  assert.equal(summary.max_drawdown_1y_pct, 0);
  assert.equal(summary.weekly_closes.at(-1).close, 359);
});

test("price rows are extracted from columnar payloads too, and empty input yields null", () => {
  const rows = extractPriceRows({ data: { date: ["2026-01-02", "2026-01-01"], close: [11, 10] } });
  assert.deepEqual(rows.map((r) => r.close), [10, 11], "sorted oldest first");
  assert.equal(summarizePriceHistory({ data: [] }), null);
});

test("buildDigest uses price summaries instead of raw rows and includes market context", () => {
  const digest = buildDigest({
    stock: { name: "X", isin: "I" },
    fundSignal: { funds_holding: 5, categories: [] },
    fundamentals: {
      fundamentals: {
        price_history: { data: { data: dailyRows(260) }, summary: summarizePriceHistory({ data: dailyRows(260) }), fetched_at: "t" },
        shareholding: { data: { data: [SHAREHOLDING] }, fetched_at: "t", stale: true }
      }
    },
    market: { sections: { fii_dii: { data: { fii_net_30d: -1200 }, fetched_at: "t" } } }
  });
  const price = digest.fundamentals.price_history.data;
  assert.equal(price.last_close, 359);
  assert.equal(price.weekly_closes.length, 16);
  assert.equal(JSON.stringify(price).includes('"open"'), false, "raw daily rows are not sent");
  assert.deepEqual(digest.market.fii_dii.data, { fii_net_30d: -1200 });
  assert.deepEqual(digest.stale_sections, ["shareholding"]);
});
