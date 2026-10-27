import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DataRefreshService } from '../../core/data-refresh';
import { formatTimestamp } from '../../core/format-timestamp';
import { LoadState } from '../../core/models/load-state';
import { CategoryChangesResult, SellSignalsService } from '../../core/sell-signals';

@Component({
  selector: 'app-sell-signals',
  imports: [RouterLink],
  templateUrl: './sell-signals.html',
  styleUrl: './sell-signals.scss',
})
export class SellSignals implements OnInit {
  private readonly sellSignals = inject(SellSignalsService);
  private readonly dataRefresh = inject(DataRefreshService);

  protected readonly timestamp = formatTimestamp;

  protected readonly state = signal<LoadState>('idle');
  protected readonly error = signal<string | null>(null);
  protected readonly hideEmpty = signal(false);

  protected readonly categories = this.sellSignals.categories;
  protected readonly results = this.sellSignals.results;
  protected readonly followed = this.sellSignals.followed;
  protected readonly totalRemoved = this.sellSignals.totalRemoved;
  protected readonly totalAdded = this.sellSignals.totalAdded;

  /** Results limited to the categories the user follows, in most-recent-first order. */
  protected readonly visibleResults = computed(() =>
    this.results().filter((result) => this.sellSignals.isFollowed(result.category)),
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
    this.sellSignals.loadCategories().subscribe({
      next: (categories) => {
        this.sellSignals.setCategories(categories);
        this.sellSignals.loadChanges().subscribe({
          next: (results) => {
            this.state.set(results.length === 0 ? 'empty' : 'success');
          },
          error: (error: unknown) => {
            this.error.set(messageOf(error));
            this.state.set('error');
          },
        });
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

  protected toggleFollowed(category: string): void {
    this.sellSignals.toggleFollowed(category);
    this.sellSignals.loadChanges().subscribe((results) => {
      this.state.set(results.length === 0 ? 'empty' : 'success');
    });
  }

  protected isFollowed(category: string): boolean {
    return this.followed().has(category);
  }

  /** A card has history when a run id exists; otherwise the empty-history message shows. */
  protected hasHistory(result: CategoryChangesResult): boolean {
    return result.changes?.run_id !== null && result.changes?.run_id !== undefined;
  }

  /** True when the run recorded no changes at all (both lists empty). */
  protected isEmptyResult(result: CategoryChangesResult): boolean {
    const changes = result.changes;
    return changes !== null && changes.removed.length === 0 && changes.added.length === 0;
  }

  /** Hide unchanged categories when the user opts in (nice-to-have §6.2). */
  protected isVisible(result: CategoryChangesResult): boolean {
    return !this.hideEmpty() || !this.isEmptyResult(result);
  }

  protected toggleHideEmpty(): void {
    this.hideEmpty.update((value) => !value);
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return 'Unable to load sell signals. Please try again.';
}
