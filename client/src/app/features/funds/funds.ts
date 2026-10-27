import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../core/api';
import { DataRefreshService } from '../../core/data-refresh';
import { formatTimestamp, parseBackendTimestamp } from '../../core/format-timestamp';
import { Fund } from '../../core/models/fund';
import { LoadState } from '../../core/models/load-state';

/** A fund is "stale" when it has never been scraped or is older than the daily cron window. */
export const STALE_AFTER_MS = 26 * 60 * 60 * 1000;

type FundSort = 'name' | 'last_scraped';

@Component({
  selector: 'app-funds',
  imports: [RouterLink],
  templateUrl: './funds.html',
  styleUrl: './funds.scss',
})
export class Funds implements OnInit {
  private readonly api = inject(ApiService);
  private readonly dataRefresh = inject(DataRefreshService);

  protected readonly timestamp = formatTimestamp;

  protected readonly state = signal<LoadState>('idle');
  protected readonly funds = signal<Fund[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly categoryFilter = signal('all');
  protected readonly sortKey = signal<FundSort>('name');
  protected readonly sortDir = signal<'asc' | 'desc'>('asc');

  protected readonly categories = computed(() => {
    const seen = new Set<string>();
    for (const fund of this.funds()) {
      if (fund.category) {
        seen.add(fund.category);
      }
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  });

  protected readonly visibleFunds = computed(() => {
    const filter = this.categoryFilter();
    const filtered =
      filter === 'all' ? this.funds() : this.funds().filter((fund) => fund.category === filter);

    const direction = this.sortDir() === 'asc' ? 1 : -1;
    const key = this.sortKey();
    return [...filtered].sort((a, b) => {
      const left = key === 'name' ? a.name.toLowerCase() : (a.last_scraped_at ?? '');
      const right = key === 'name' ? b.name.toLowerCase() : (b.last_scraped_at ?? '');
      return left.localeCompare(right) * direction;
    });
  });

  protected readonly neverScrapedCount = computed(
    () => this.funds().filter((fund) => fund.last_scraped_at === null).length,
  );

  private readonly refreshEffect = effect(() => {
    if (this.dataRefresh.token() > 0) {
      this.load();
    }
  });

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.state.set('loading');
    this.error.set(null);
    this.api.getFunds().subscribe({
      next: (funds) => {
        this.funds.set(funds);
        this.state.set(funds.length === 0 ? 'empty' : 'success');
      },
      error: (error: unknown) => {
        this.error.set(messageOf(error));
        this.state.set('error');
      },
    });
  }

  protected retry(): void {
    this.load();
  }

  protected onFilter(value: string): void {
    this.categoryFilter.set(value);
  }

  protected setSort(key: FundSort): void {
    if (this.sortKey() === key) {
      this.sortDir.set(this.sortDir() === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortKey.set(key);
      this.sortDir.set('asc');
    }
  }

  /** Flags funds whose `last_scraped_at` is missing or older than the daily cron window. */
  protected needsRefresh(fund: Fund): boolean {
    const scrapedAt = parseBackendTimestamp(fund.last_scraped_at);
    if (scrapedAt === null) {
      return true;
    }
    return Date.now() - scrapedAt.getTime() > STALE_AFTER_MS;
  }

  protected refreshLabel(fund: Fund): string {
    if (fund.last_scraped_at === null) {
      return 'Never scraped';
    }
    return this.needsRefresh(fund) ? 'Needs refresh' : 'Up to date';
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return 'Unable to load tracked funds. Please try again.';
}
