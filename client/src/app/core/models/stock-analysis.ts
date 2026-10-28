import { FundSignal } from './stock-detail';
import { FundamentalsError } from './stock-fundamentals';

/** BUY/IGNORE when the user does not hold the stock; HOLD/SELL when they do. */
export type AnalysisVerdict = 'BUY' | 'IGNORE' | 'HOLD' | 'SELL';

/** `GET /api/stocks/:id/analysis` — AI decision support, cached until its inputs change. */
export interface StockAnalysis {
  stock: { id: number; name: string; isin: string | null; symbol: string | null };
  held: boolean;
  analysis: {
    verdict: AnalysisVerdict;
    confidence: 'low' | 'medium' | 'high';
    summary: string;
    fund_consensus: string;
    valuation: string;
    strengths: string[];
    risks: string[];
    red_flags: string[];
    what_would_change_view: string[];
    data_gaps: string[];
  };
  model: { provider: string; model: string };
  /** UTC `YYYY-MM-DD HH:MM:SS`. */
  generated_at: string;
  /** Reused from Kosha's database (inputs unchanged since it was generated). */
  cached: boolean;
  inputs: {
    fund_signal: FundSignal | null;
    fundamentals_sections: string[];
    stale_sections: string[];
  };
  errors: Array<FundamentalsError & { source?: string }>;
  disclaimer: string;
}
