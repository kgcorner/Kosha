import { Injectable, computed, inject, signal } from '@angular/core';
import { catchError, forkJoin, map, Observable, of, shareReplay } from 'rxjs';

import { ApiService } from './api';
import { FALLBACK_CATEGORIES } from './categories';
import { isExcludedStockName } from './excluded-names';
import { CategoryChange, CategoryChanges } from './models/category-changes';

/** localStorage key holding the user's followed categories. */
export const FOLLOWED_CATEGORIES_STORAGE_KEY = 'kosha.followedCategories';

/** A per-category result: either loaded changes or an isolated error. */
export interface CategoryChangesResult {
  category: string;
  changes: CategoryChanges | null;
  error: string | null;
}

/**
 * Loads per-category change history and exposes the union of all `removed`
 * stock names as a `Set` so the leaderboard can badge sell-signal rows (§6.1).
 */
@Injectable({ providedIn: 'root' })
export class SellSignalsService {
  private readonly api = inject(ApiService);

  private readonly categoriesState = signal<string[]>([]);
  private readonly followedState = signal<Set<string>>(new Set());
  private readonly resultsState = signal<CategoryChangesResult[]>([]);

  /** Categories discovered from funds (or the static fallback). */
  readonly categories = this.categoriesState.asReadonly();
  readonly followed = this.followedState.asReadonly();
  readonly results = this.resultsState.asReadonly();

  /** Stock names currently flagged as removed — drives leaderboard badges. */
  readonly removedNames = computed(() => {
    const names = new Set<string>();
    for (const result of this.resultsState()) {
      for (const change of result.changes?.removed ?? []) {
        names.add(normalizeName(change.name));
      }
    }
    return names;
  });

  readonly totalRemoved = computed(() =>
    this.resultsState().reduce((sum, result) => sum + (result.changes?.removed.length ?? 0), 0),
  );

  readonly totalAdded = computed(() =>
    this.resultsState().reduce((sum, result) => sum + (result.changes?.added.length ?? 0), 0),
  );

  /** True when any loaded category has a recorded run with changes. */
  readonly hasAnyHistory = computed(() =>
    this.resultsState().some(
      (result) => result.changes?.run_id !== null && result.changes?.run_id !== undefined,
    ),
  );

  /** Discover categories from funds, falling back to the static seven when empty. */
  loadCategories(): Observable<string[]> {
    return this.api.getFunds().pipe(
      map((funds) => {
        const seen = new Set<string>();
        for (const fund of funds) {
          if (fund.category) {
            seen.add(fund.category);
          }
        }
        const discovered = [...seen].sort((a, b) => a.localeCompare(b));
        return discovered.length > 0 ? discovered : [...FALLBACK_CATEGORIES];
      }),
      catchError(() => of([...FALLBACK_CATEGORIES])),
      shareReplay(1),
    );
  }

  /** Reconcile followed categories with the discovered list, persisting to storage. */
  setCategories(categories: string[]): void {
    this.categoriesState.set(categories);
    const stored = readFollowedCategories();
    if (stored === null) {
      this.followedState.set(new Set(categories));
    } else {
      const allowed = new Set(categories);
      this.followedState.set(new Set([...stored].filter((name) => allowed.has(name))));
    }
    persistFollowedCategories(this.followedState());
  }

  isFollowed(category: string): boolean {
    return this.followedState().has(category);
  }

  toggleFollowed(category: string): void {
    const next = new Set(this.followedState());
    if (next.has(category)) {
      next.delete(category);
    } else {
      next.add(category);
    }
    this.followedState.set(next);
    persistFollowedCategories(next);
  }

  /**
   * Fetch changes for the followed categories. A single category failure is
   * captured inline (not thrown) so one bad card never blanks the whole page.
   */
  loadChanges(): Observable<CategoryChangesResult[]> {
    const categories = this.categories().filter((category) => this.isFollowed(category));
    if (categories.length === 0) {
      this.resultsState.set([]);
      return of([]);
    }
    return forkJoin(categories.map((category) => this.loadOne(category))).pipe(
      map((results) => {
        const sorted = [...results].sort((a, b) => compareByRunAt(b, a));
        this.resultsState.set(sorted);
        return sorted;
      }),
    );
  }

  /** Refresh the change set, keeping prior results visible on failure. */
  refresh(): Observable<CategoryChangesResult[]> {
    return this.loadChanges();
  }

  private loadOne(category: string): Observable<CategoryChangesResult> {
    return this.api.getCategoryChanges(category).pipe(
      map((changes) => ({ category, changes: withoutExcluded(changes), error: null })),
      catchError((error: unknown) => of({ category, changes: null, error: errorMessage(error) })),
    );
  }
}

/**
 * Strips parser junk (e.g. "Net Payables", "Repo") from a category's change
 * lists so badges, totals and rendered lists all agree on the same set.
 */
function withoutExcluded(changes: CategoryChanges): CategoryChanges {
  const keep = (change: CategoryChange) => !isExcludedStockName(change.name);
  return {
    ...changes,
    removed: changes.removed.filter(keep),
    added: changes.added.filter(keep),
  };
}

function compareByRunAt(a: CategoryChangesResult, b: CategoryChangesResult): number {
  return (a.changes?.run_at ?? '').localeCompare(b.changes?.run_at ?? '');
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return 'Failed to load category changes.';
}

function readFollowedCategories(): string[] | null {
  try {
    const raw = globalThis.localStorage?.getItem(FOLLOWED_CATEGORIES_STORAGE_KEY) ?? null;
    return raw === null ? null : (JSON.parse(raw) as string[]);
  } catch {
    return null;
  }
}

function persistFollowedCategories(categories: Set<string>): void {
  try {
    globalThis.localStorage?.setItem(
      FOLLOWED_CATEGORIES_STORAGE_KEY,
      JSON.stringify([...categories]),
    );
  } catch {
    // Ignore storage failures.
  }
}
