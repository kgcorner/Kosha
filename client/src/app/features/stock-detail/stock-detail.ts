import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../core/api';
import { formatTimestamp } from '../../core/format-timestamp';
import { LoadState } from '../../core/models/load-state';
import { StockDetail as StockDetailModel } from '../../core/models/stock-detail';
import { FundamentalsSection, StockFundamentals } from '../../core/models/stock-fundamentals';
import { DataView } from '../../shared/data-view/data-view';

/** Display order and labels for fundamentals sections (unknown ones go last). */
export const FUNDAMENTALS_SECTIONS: ReadonlyArray<{ key: string; title: string; hint: string }> = [
  { key: 'profile', title: 'Company profile', hint: 'Price, valuation and quality ratios' },
  { key: 'financials', title: 'Financials', hint: 'Quarterly and annual statements' },
  {
    key: 'shareholding',
    title: 'Shareholding',
    hint: 'Promoter, FII, DII and public holding by quarter',
  },
  { key: 'pledge', title: 'Promoter pledge', hint: 'Share pledges by promoters' },
];

/**
 * `/stock/:stockId` — everything the scrape stored about one stock (ranking,
 * category coverage, holding funds, recent category changes), plus an
 * on-demand "Fetch fundamentals" action. Fundamentals are never loaded
 * automatically: the backend calls its provider at most once per stock per
 * day and serves its stored copy otherwise.
 */
@Component({
  selector: 'app-stock-detail',
  imports: [RouterLink, DataView],
  templateUrl: './stock-detail.html',
  styleUrl: './stock-detail.scss',
})
export class StockDetail {
  private readonly api = inject(ApiService);

  /** Route param bound via `withComponentInputBinding()`. */
  readonly stockId = input.required<string>();

  protected readonly timestamp = formatTimestamp;

  protected readonly state = signal<LoadState>('idle');
  protected readonly detail = signal<StockDetailModel | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly fundamentalsState = signal<LoadState>('idle');
  protected readonly fundamentals = signal<StockFundamentals | null>(null);
  protected readonly fundamentalsError = signal<string | null>(null);

  protected readonly numericId = computed(() => {
    const id = Number(this.stockId());
    return Number.isInteger(id) && id > 0 ? id : null;
  });

  /** Latest stored fundamentals fetch, if any (shown before the user fetches). */
  protected readonly lastFetched = computed(() => {
    const cached = this.detail()?.fundamentals_cached ?? [];
    return (
      cached
        .map((entry) => entry.fetched_at)
        .sort()
        .at(-1) ?? null
    );
  });

  protected readonly sections = computed(() => {
    const data = this.fundamentals()?.fundamentals ?? {};
    const known = FUNDAMENTALS_SECTIONS.filter((section) => data[section.key]).map((section) => ({
      ...section,
      section: data[section.key] as FundamentalsSection,
    }));
    const extra = Object.keys(data)
      .filter((key) => !FUNDAMENTALS_SECTIONS.some((section) => section.key === key) && data[key])
      .map((key) => ({ key, title: key, hint: '', section: data[key] as FundamentalsSection }));
    return [...known, ...extra];
  });

  protected readonly fetchedFromProvider = computed(
    () => this.sections().filter((entry) => !entry.section.cached).length,
  );

  private readonly loadOnIdChange = effect(() => {
    const id = this.numericId();
    // A new stock id resets the page (navigating between stocks reuses the component).
    this.fundamentals.set(null);
    this.fundamentalsState.set('idle');
    this.fundamentalsError.set(null);
    if (id === null) {
      this.detail.set(null);
      this.error.set(`“${this.stockId()}” is not a valid stock id.`);
      this.state.set('error');
      return;
    }
    this.load(id);
  });

  protected load(id = this.numericId()): void {
    if (id === null) {
      return;
    }
    this.state.set('loading');
    this.error.set(null);
    this.api.getStock(id).subscribe({
      next: (detail) => {
        this.detail.set(detail);
        this.state.set('success');
      },
      error: (error: unknown) => {
        this.detail.set(null);
        this.error.set(messageOf(error, 'Unable to load this stock.'));
        this.state.set('error');
      },
    });
  }

  protected fetchFundamentals(): void {
    const id = this.numericId();
    if (id === null || this.fundamentalsState() === 'loading') {
      return;
    }
    this.fundamentalsState.set('loading');
    this.fundamentalsError.set(null);
    this.api.getFundamentals(id).subscribe({
      next: (result) => {
        this.fundamentals.set(result);
        this.fundamentalsState.set(
          Object.keys(result.fundamentals).length === 0 ? 'empty' : 'success',
        );
        // The symbol is resolved on first fetch; reflect it in the header.
        const current = this.detail();
        if (current && result.stock.symbol && !current.stock.symbol) {
          this.detail.set({ ...current, stock: { ...current.stock, symbol: result.stock.symbol } });
        }
      },
      error: (error: unknown) => {
        this.fundamentalsError.set(messageOf(error, 'Unable to fetch fundamentals.'));
        this.fundamentalsState.set('error');
      },
    });
  }

  protected weightRange(): string {
    const signal = this.detail()?.fund_signal;
    if (!signal || signal.weight_avg === null || signal.weight_avg === undefined) {
      return '—';
    }
    const avg = `${formatNumber(signal.weight_avg)}%`;
    const { weight_min: min, weight_max: max } = signal;
    if (min === null || min === undefined || max === null || max === undefined || min === max) {
      return avg;
    }
    return `${avg} (${formatNumber(min)}–${formatNumber(max)}%)`;
  }

  protected coverage(fundsHolding: number, fundsInCategory: number): number {
    return fundsInCategory > 0 ? Math.round((fundsHolding / fundsInCategory) * 100) : 0;
  }

  protected number(value: number | null | undefined, digits = 2): string {
    return value === null || value === undefined ? '—' : formatNumber(value, digits);
  }

  protected percent(value: number | null | undefined): string {
    return value === null || value === undefined ? '—' : `${formatNumber(value)}%`;
  }
}

/** Indian digit grouping (12,34,567.89). */
export function formatNumber(value: number, digits = 2): string {
  return value.toLocaleString('en-IN', { maximumFractionDigits: digits });
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return fallback;
}
