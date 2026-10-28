import { FundSignal } from './stock-detail';

export type FundamentalsSectionName =
  'profile' | 'financials' | 'shareholding' | 'pledge' | 'price_history' | 'forecasts';

/** `GET /api/stocks/:id/fundamentals` — provider data, stored and reused per calendar day. */
export interface StockFundamentals {
  stock: { id: number; name: string; isin: string | null; symbol: string | null };
  provider: string;
  fund_signal: FundSignal;
  fundamentals: Partial<Record<FundamentalsSectionName | string, FundamentalsSection>>;
  cache_policy?: { rule: string; timezone: string; today: string };
  errors: FundamentalsError[];
}

export interface FundamentalsSection {
  /** The provider's payload, unmodified; its shape is defined by the provider. */
  data: unknown;
  /** UTC `YYYY-MM-DD HH:MM:SS`. */
  fetched_at: string;
  provider: string;
  /** Served from Kosha's database without calling the provider. */
  cached: boolean;
  /** The provider failed today, so an older stored copy was returned. */
  stale: boolean;
  /** Numbers computed by the backend from `data` (price history: returns, SMAs, 52w range ...). */
  summary?: Record<string, unknown> | null;
  /** Chart-ready series (price history: one point per trading day, oldest first). */
  series?: Array<{ date: string; close: number; volume: number | null }>;
}

export interface FundamentalsError {
  section: string;
  code: string | null;
  message: string;
  retry_after_seconds?: number;
}
