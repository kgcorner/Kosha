import { Injectable, computed, inject, signal, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, Subscription, timer } from 'rxjs';
import { switchMap, takeUntil, takeWhile, tap } from 'rxjs/operators';

import { ApiService } from './api';
import { ApiError } from './error.interceptor';
import { ScrapeJob, ScrapeStage, ScrapeStatus } from './models/scrape-job';

/** Poll interval while a job is queued/running. Kept within NFR-4 (1s–5s). */
export const POLL_INTERVAL_MS = 3000;

/** localStorage key that lets a page reload resume polling the active job. */
export const ACTIVE_JOB_STORAGE_KEY = 'kosha.activeJobId';

const TERMINAL_STATUSES: readonly ScrapeStatus[] = ['completed', 'failed'];

const STAGE_LABELS: Record<ScrapeStage, string> = {
  discovering_funds: 'Discovering funds',
  scraping_holdings: 'Scraping holdings',
  aggregating: 'Aggregating consensus',
  detecting_changes: 'Detecting category changes',
  completed: 'Completed',
  failed: 'Failed',
};

/** Order of the four work stages, used to derive a coarse progress fraction. */
export const STAGE_ORDER: readonly ScrapeStage[] = [
  'discovering_funds',
  'scraping_holdings',
  'aggregating',
  'detecting_changes',
];

const STATUS_LABELS: Record<ScrapeStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
};

/**
 * Owns the active scrape job and drives polling. Shared by the app shell
 * (§5.1) and the Jobs page (§6.4), so progress is visible on every route.
 *
 * Polling stops on `completed`/`failed`, on `404` (job vanished), and on
 * `DestroyRef` teardown. The active id is persisted to `localStorage` so a
 * reload resumes monitoring.
 */
@Injectable({ providedIn: 'root' })
export class JobMonitorService {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly jobState = signal<ScrapeJob | null>(null);
  private readonly pollingState = signal(false);
  private readonly staleState = signal(false);

  /** The job currently being monitored (or the last completed/failed job). */
  readonly job = this.jobState.asReadonly();
  readonly isPolling = this.pollingState.asReadonly();
  /** True when `GET /api/jobs/:id` returned `404` for a persisted job. */
  readonly isStale = this.staleState.asReadonly();

  readonly isRunning = computed(() => {
    const status = this.jobState()?.status;
    return status === 'queued' || status === 'running';
  });

  readonly canStart = computed(() => !this.isRunning());

  readonly stageLabel = computed(() => {
    const stage = this.jobState()?.stage;
    return stage ? STAGE_LABELS[stage] : null;
  });

  readonly statusLabel = computed(() => {
    const status = this.jobState()?.status;
    return status ? STATUS_LABELS[status] : null;
  });

  /** Coarse 0–100 progress derived from stage order (nice-to-have §6.4). */
  readonly progress = computed(() => {
    const stage = this.jobState()?.stage;
    if (!stage) {
      return 0;
    }
    if (stage === 'completed') {
      return 100;
    }
    if (stage === 'failed') {
      return 0;
    }
    const index = STAGE_ORDER.indexOf(stage);
    return index < 0 ? 0 : Math.round(((index + 1) / STAGE_ORDER.length) * 100);
  });

  private readonly stopPolling = new Subject<void>();
  private pollSubscription: Subscription | null = null;

  constructor() {
    const persisted = readPersistedJobId();
    if (persisted !== null) {
      this.resume(persisted);
    }
  }

  /** Begin monitoring an already-known job (e.g. the `202` response or a `409`). */
  track(job: ScrapeJob): void {
    this.jobState.set(job);
    this.staleState.set(false);
    persistJobId(job.id);
    if (this.isTerminal(job.status)) {
      this.stop();
      return;
    }
    this.beginPolling(job.id);
  }

  /** Resume monitoring a job id (e.g. loaded from `localStorage` after a reload). */
  resume(id: number): void {
    this.pollingState.set(true);
    this.api
      .getJob(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (job) => this.track(job),
        error: (error: unknown) => this.handlePollingError(id, error),
      });
  }

  /** Stop polling while keeping the last known job for display. */
  stop(): void {
    this.stopPolling.next();
    this.pollSubscription?.unsubscribe();
    this.pollSubscription = null;
    this.pollingState.set(false);
  }

  /** Clear all monitoring state, including the persisted id. */
  reset(): void {
    this.stop();
    this.jobState.set(null);
    this.staleState.set(false);
    clearPersistedJobId();
  }

  private beginPolling(id: number): void {
    this.stop();
    this.staleState.set(false);
    this.pollingState.set(true);

    this.pollSubscription = timer(0, POLL_INTERVAL_MS)
      .pipe(
        switchMap(() => this.api.getJob(id)),
        tap((job) => this.jobState.set(job)),
        takeWhile((job) => !this.isTerminal(job.status), true),
        takeUntil(this.stopPolling),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (job) => {
          persistJobId(job.id);
          if (this.isTerminal(job.status)) {
            this.pollingState.set(false);
          }
        },
        error: (error: unknown) => this.handlePollingError(id, error),
        complete: () => this.pollingState.set(false),
      });
  }

  private handlePollingError(id: number, error: unknown): void {
    this.stop();
    if (error instanceof ApiError && error.status === 404) {
      this.markStale();
    }
    // Other errors leave the last known job in place; the Jobs page surfaces them.
  }

  private markStale(): void {
    this.staleState.set(true);
    this.jobState.set(null);
    clearPersistedJobId();
  }

  private isTerminal(status: ScrapeStatus): boolean {
    return TERMINAL_STATUSES.includes(status);
  }
}

function readPersistedJobId(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(ACTIVE_JOB_STORAGE_KEY) ?? null;
    if (raw === null) {
      return null;
    }
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function persistJobId(id: number): void {
  try {
    globalThis.localStorage?.setItem(ACTIVE_JOB_STORAGE_KEY, String(id));
  } catch {
    // Storage may be unavailable (private mode); polling still works in-memory.
  }
}

function clearPersistedJobId(): void {
  try {
    globalThis.localStorage?.removeItem(ACTIVE_JOB_STORAGE_KEY);
  } catch {
    // Ignore.
  }
}
