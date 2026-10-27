import { StockMetrics } from './stock-metrics';

/**
 * One row of the consensus leaderboard returned by
 * `GET /api/stocks/leaderboard`. Fields mirror the API exactly (snake_case) so
 * no mapping layer is required.
 */
export interface LeaderboardRow {
  stock_id: number;
  name: string;
  /** Number of distinct funds holding the stock. */
  consensus_score: number;
  /**
   * Raw sum of the Assets % across every fund holding the stock. Kept for
   * compatibility/internal ordering only — a stock held by 50 funds at ~1% each
   * would read "50", which is meaningless. Display `weight_avg` (with the
   * `weight_min`–`weight_max` range) instead.
   */
  total_weight_sum: number;
  /**
   * Average Assets % a single holding fund allocates to this stock. `null` when
   * no underlying fund publishes a parsable weight; `0` is never returned.
   */
  weight_avg: number | null;
  /** Lowest per-fund Assets % across the funds holding the stock; `null` if none publish one. */
  weight_min: number | null;
  /** Highest per-fund Assets % across the funds holding the stock; `null` if none publish one. */
  weight_max: number | null;
  /** 1-based ranking. Global by default; recomputed within the category when filtering. */
  rank: number;
  /** Canonical stock detail page the metrics were scraped from; `null` if none captured. */
  stock_url: string | null;
  /**
   * Full metric set scraped from the stock's own detail page (price, valuation
   * ratios, shareholding, peers ...). `null` until that stock has been visited
   * by a scrape.
   */
  metrics: StockMetrics | null;
  /**
   * Every fund category that holds this stock (e.g. `["Large Cap", "Flexi Cap"]`).
   * Drives the per-row category badges and confirms the category filter's scope.
   */
  categories: string[];
  /** AI thesis; `null` until AI enrichment runs (disabled by default). */
  thesis: string | null;
  /** AI pros; `[]` until AI enrichment runs. */
  pros: string[];
  /** AI cons; `[]` until AI enrichment runs. */
  cons: string[];
  /** Backend-local timestamp `"YYYY-MM-DD HH:MM:SS"`; `null` until analyzed. */
  last_analyzed_at: string | null;
}
