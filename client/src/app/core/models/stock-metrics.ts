/**
 * Metric set scraped from a stock's own Groww detail page, returned inline on
 * leaderboard rows (`GET /api/stocks/leaderboard`) and via
 * `GET /api/stocks/:id/metrics`.
 *
 * The groups and keys mirror `config/scraping.json` → `selectors.stock_page.metrics`,
 * so the shape is configuration-driven rather than fixed; a scalar is a string
 * (values keep their original formatting, e.g. `"₹11,23,322Cr"`), and trend-style
 * metrics are string arrays.
 */
export interface StockMetrics {
  core_identifiers_and_market_metrics?: Record<string, MetricValue>;
  valuation_and_fundamental_ratios?: Record<string, MetricValue>;
  financial_performance_trends?: Record<string, MetricValue>;
  shareholding_pattern?: Record<string, MetricValue>;
  corporate_actions_and_events?: Record<string, MetricValue>;
  recent_news_and_regulatory_filings?: Record<string, MetricValue>;
  peer_comparison_benchmarks?: Record<string, MetricValue>;
  [group: string]: Record<string, MetricValue> | undefined;
}

/** A scalar metric renders as text; a trend metric renders as a list of rows. */
export type MetricValue = string | string[] | Record<string, unknown> | null;
