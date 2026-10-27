/** A single stock that entered or left a category. */
export interface CategoryChange {
  stock_id: number;
  name: string;
}

/**
 * Latest category change run returned by
 * `GET /api/categories/:category/changes`. An unknown/unchanged category
 * returns the empty shape (`run_id: null`, `run_at: null`, empty lists) — not
 * a `404`, so the UI treats that as "no signal".
 */
export interface CategoryChanges {
  category: string;
  run_id: number | null;
  /** Backend-local timestamp `"YYYY-MM-DD HH:MM:SS"`. */
  run_at: string | null;
  /** Stocks removed since the previous run — the SELL SIGNAL. */
  removed: CategoryChange[];
  /** Stocks newly added since the previous run. */
  added: CategoryChange[];
}
