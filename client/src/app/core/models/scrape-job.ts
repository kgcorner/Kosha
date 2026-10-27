export type ScrapeStatus = 'queued' | 'running' | 'completed' | 'failed';

export type ScrapeStage =
  | 'discovering_funds'
  | 'scraping_holdings'
  | 'aggregating'
  | 'detecting_changes'
  | 'completed'
  | 'failed';

/** Result summary recorded when a scrape job completes. */
export interface ScrapeResult {
  funds: number;
  stocks: number;
  /** Number of stock detail pages whose metrics were captured this run. */
  stock_metrics?: number;
  changes: { added: number; removed: number };
}

/**
 * A scrape job record returned by `POST /api/jobs/scrape`, `GET /api/jobs/:id`
 * and `GET /api/jobs`.
 */
export interface ScrapeJob {
  id: number;
  status: ScrapeStatus;
  stage: ScrapeStage | null;
  funds_found: number | null;
  stocks: number | null;
  result: ScrapeResult | null;
  error: string | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}
