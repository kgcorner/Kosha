import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../core/api';
import { DataRefreshService } from '../../core/data-refresh';
import { isExcludedStockName } from '../../core/excluded-names';
import { formatTimestamp } from '../../core/format-timestamp';
import { LeaderboardRow } from '../../core/models/leaderboard-row';
import { LoadState } from '../../core/models/load-state';
import { SellSignalsService } from '../../core/sell-signals';

export const LEADERBOARD_PAGE_SIZES: readonly number[] = [10, 20, 50];
export const DEFAULT_PAGE_SIZE = 20;

type SortKey = 'rank' | 'consensus';

@Component({
  selector: 'app-leaderboard',
  imports: [RouterLink],
  templateUrl: './leaderboard.html',
  styleUrl: './leaderboard.scss',
})
export class Leaderboard implements OnInit {
  private readonly api = inject(ApiService);
  private readonly sellSignals = inject(SellSignalsService);
  private readonly dataRefresh = inject(DataRefreshService);

  protected readonly timestamp = formatTimestamp;
  protected readonly pageSizes = LEADERBOARD_PAGE_SIZES;

  protected readonly state = signal<LoadState>('idle');
  protected readonly rows = signal<LeaderboardRow[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly pageSize = signal(DEFAULT_PAGE_SIZE);
  protected readonly offset = signal(0);
  /** Category filter; `null` means every category (a global ranking). */
  protected readonly category = signal<string | null>(null);
  protected readonly categories = signal<string[]>([]);
  protected readonly sortKey = signal<SortKey>('rank');
  protected readonly sortDir = signal<'asc' | 'desc'>('asc');
  protected readonly search = signal('');
  protected readonly expandedId = signal<number | null>(null);

  protected readonly page = computed(() => Math.floor(this.offset() / this.pageSize()) + 1);

  /** Next is disabled on a short page — there is no total count to page against. */
  protected readonly hasNext = computed(() => this.rows().length >= this.pageSize());
  protected readonly hasPrev = computed(() => this.offset() > 0);

  protected readonly visibleRows = computed(() => {
    // Parser junk (e.g. "Net Payables", "Repo") is dropped from the rendered list,
    // but `rows()` keeps the raw server page so pagination stays intact.
    const term = this.search().trim().toLowerCase();
    const filtered = this.rows()
      .filter((row) => !isExcludedStockName(row.name))
      .filter((row) => (term ? row.name.toLowerCase().includes(term) : true));

    const key = this.sortKey();
    const direction = this.sortDir() === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const left = key === 'rank' ? a.rank : a.consensus_score;
      const right = key === 'rank' ? b.rank : b.consensus_score;
      return (left - right) * direction;
    });
  });

  protected readonly removedNames = this.sellSignals.removedNames;

  private readonly refreshEffect = effect(() => {
    // Re-run whenever another screen requests a reload (e.g. after a scrape completes).
    if (this.dataRefresh.token() > 0) {
      this.load();
    }
  });

  ngOnInit(): void {
    this.loadCategories();
    this.sellSignals.loadCategories().subscribe((categories) => {
      this.sellSignals.setCategories(categories);
      this.sellSignals.loadChanges().subscribe();
    });
    this.load();
  }

  /** Fund categories for the filter; silently empty if the call fails. */
  protected loadCategories(): void {
    this.api.getCategories().subscribe({
      next: (categories) => this.categories.set(categories),
      error: () => this.categories.set([]),
    });
  }

  protected load(): void {
    this.state.set('loading');
    this.error.set(null);
    this.api
      .getLeaderboard({
        limit: this.pageSize(),
        offset: this.offset(),
        category: this.category() ?? undefined,
      })
      .subscribe({
        next: (rows) => {
          this.rows.set(rows);
          this.state.set(rows.length === 0 ? 'empty' : 'success');
        },
        error: (error: unknown) => {
          this.error.set(messageOf(error));
          this.state.set('error');
        },
      });
  }

  /** Apply the category filter and return to page 1 (the ranking is re-scoped). */
  protected changeCategory(value: string): void {
    this.category.set(value === '' ? null : value);
    this.offset.set(0);
    this.expandedId.set(null);
    this.load();
  }

  protected retry(): void {
    this.load();
  }

  protected nextPage(): void {
    if (!this.hasNext()) {
      return;
    }
    this.offset.set(this.offset() + this.pageSize());
    this.expandedId.set(null);
    this.load();
  }

  protected previousPage(): void {
    if (!this.hasPrev()) {
      return;
    }
    this.offset.set(Math.max(0, this.offset() - this.pageSize()));
    this.expandedId.set(null);
    this.load();
  }

  protected changePageSize(value: string): void {
    this.pageSize.set(Number(value));
    this.offset.set(0);
    this.load();
  }

  protected setSort(key: SortKey): void {
    if (this.sortKey() === key) {
      this.sortDir.set(this.sortDir() === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortKey.set(key);
      this.sortDir.set('asc');
    }
  }

  protected onSearch(value: string): void {
    this.search.set(value);
  }

  protected toggleExpanded(row: LeaderboardRow): void {
    this.expandedId.set(this.expandedId() === row.stock_id ? null : row.stock_id);
  }

  protected isExpanded(row: LeaderboardRow): boolean {
    return this.expandedId() === row.stock_id;
  }

  /**
   * Per-fund weight: the average Assets % with the min–max range, e.g.
   * `1.24% (0.4–3.1%)`. We never display `total_weight_sum` — summing one
   * stock's weight across dozens of funds produces a meaningless figure.
   * Renders `—` when no fund publishes a parsable weight.
   */
  protected weightLabel(row: LeaderboardRow): string {
    const avg = row.weight_avg;
    if (avg === null || avg === undefined) {
      return '—';
    }
    const average = `${formatWeight(avg)}%`;
    const { weight_min: min, weight_max: max } = row;
    if (min === null || max === null || min === max) {
      return average;
    }
    return `${average} (${formatWeight(min)}–${formatWeight(max)}%)`;
  }

  protected hasEnrichment(row: LeaderboardRow): boolean {
    return (
      (row.thesis !== null && row.thesis.trim() !== '') ||
      row.pros.length > 0 ||
      row.cons.length > 0
    );
  }

  protected isSellSignal(row: LeaderboardRow): boolean {
    return this.removedNames().has(row.name.trim().toLowerCase());
  }

  /** Highlighted market metrics shown inline under the stock name (or `—` if none). */
  protected priceLabel(row: LeaderboardRow): string {
    const core = row.metrics?.core_identifiers_and_market_metrics;
    return scalarLabel(core?.['live_price']) ?? '—';
  }

  protected marketCapLabel(row: LeaderboardRow): string | null {
    return scalarLabel(row.metrics?.core_identifiers_and_market_metrics?.['market_cap']);
  }

  protected hasMetrics(row: LeaderboardRow): boolean {
    return this.metricGroups(row).length > 0;
  }

  /** Metric groups flattened into label/value rows for the expanded detail panel. */
  protected metricGroups(
    row: LeaderboardRow,
  ): Array<{ group: string; entries: Array<{ key: string; value: string }> }> {
    const metrics = row.metrics;
    if (!metrics) {
      return [];
    }
    return Object.entries(metrics)
      .map(([group, fields]) => {
        const entries = Object.entries(fields ?? {})
          .map(([key, value]) => ({ key, value: metricValueLabel(value) }))
          .filter((entry) => entry.value !== '');
        return { group, entries };
      })
      .filter((entry) => entry.entries.length > 0);
  }

  protected humanize(key: string): string {
    return key.replace(/_/g, ' ');
  }
}

// Render a scalar metric as text; arrays/objects are summarized into one string.
function metricValueLabel(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => scalarLabel(entry))
      .filter((entry): entry is string => !!entry)
      .join(' · ');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => {
        const rendered = scalarLabel(entry);
        return rendered ? `${key.replace(/_/g, ' ')}: ${rendered}` : '';
      })
      .filter(Boolean)
      .join(' · ');
  }
  return String(value);
}

function scalarLabel(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Trim a weight percentage to at most 2 decimals without trailing zeros (1.2, 3.14). */
function formatWeight(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return 'Unable to load the leaderboard. Please try again.';
}
