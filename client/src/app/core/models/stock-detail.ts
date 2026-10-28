/**
 * Everything the scrape stored about one stock, from `GET /api/stocks/:id`.
 * No external calls are made to build it. Fields mirror the API (snake_case).
 */
export interface StockDetail {
  stock: {
    id: number;
    name: string;
    isin: string | null;
    /** NSE symbol; known once fundamentals have been fetched at least once. */
    symbol: string | null;
    sector: string | null;
    url: string | null;
  };
  totals: {
    funds_holding: number;
    /** Shares held across all tracked funds; `null` when the source has no quantities. */
    total_quantity: number | null;
    /** Market value held across all tracked funds, in ₹ crore. */
    total_market_value_cr: number | null;
    /** Latest portfolio disclosure date among the holdings (`YYYY-MM-DD`). */
    latest_as_of: string | null;
  };
  /** One row per holding fund, highest weight first. */
  holdings: StockHolding[];
  /** Category add/remove events for this stock, newest run first. */
  recent_changes: StockCategoryChange[];
  /** Fundamentals sections already stored, with their fetch time (UTC). */
  fundamentals_cached: Array<{ section: string; fetched_at: string }>;
  fund_signal: FundSignal;
}

export interface StockHolding {
  fund_id: number;
  fund_name: string;
  category: string | null;
  /** % of the fund's NAV. */
  weight_percentage: number | null;
  quantity: number | null;
  /** ₹ crore. */
  market_value_cr: number | null;
  as_of: string | null;
}

export interface StockCategoryChange {
  category: string;
  change_type: 'added' | 'removed';
  run_at: string;
  run_id: number;
}

/** Kosha's own consensus signal for one stock. */
export interface FundSignal {
  funds_holding: number;
  rank: number | null;
  weight_avg?: number | null;
  weight_min?: number | null;
  weight_max?: number | null;
  categories: Array<{
    category: string;
    funds_holding: number;
    funds_in_category: number;
    weight_avg: number | null;
  }>;
}
