import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval } from 'rxjs';

import { ApiService } from '../../core/api';
import { DataRefreshService } from '../../core/data-refresh';
import { formatElapsedSince } from '../../core/format-duration';
import { formatTimestamp } from '../../core/format-timestamp';
import { JobMonitorService } from '../../core/job-monitor';
import { LoadState } from '../../core/models/load-state';
import { ScrapeJob, ScrapeStage } from '../../core/models/scrape-job';

export const JOB_HISTORY_LIMIT = 20;

const STAGE_LABELS: Record<ScrapeStage, string> = {
  discovering_funds: 'Discovering funds',
  scraping_holdings: 'Scraping holdings',
  aggregating: 'Aggregating consensus',
  detecting_changes: 'Detecting category changes',
  completed: 'Completed',
  failed: 'Failed',
};

@Component({
  selector: 'app-jobs',
  templateUrl: './jobs.html',
  styleUrl: './jobs.scss',
})
export class Jobs implements OnInit {
  private readonly api = inject(ApiService);
  private readonly monitor = inject(JobMonitorService);
  private readonly dataRefresh = inject(DataRefreshService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly timestamp = formatTimestamp;

  protected readonly historyState = signal<LoadState>('idle');
  protected readonly history = signal<ScrapeJob[]>([]);
  protected readonly historyError = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly starting = signal(false);
  protected readonly now = signal(Date.now());
  protected readonly log = signal<string[]>([]);

  protected readonly job = this.monitor.job;
  protected readonly isRunning = this.monitor.isRunning;
  protected readonly stageLabel = this.monitor.stageLabel;
  protected readonly statusLabel = this.monitor.statusLabel;
  protected readonly progress = this.monitor.progress;
  protected readonly isStale = this.monitor.isStale;

  protected readonly canStart = computed(() => !this.isRunning() && !this.starting());
  protected readonly elapsed = computed(() =>
    formatElapsedSince(this.job()?.started_at ?? null, new Date(this.now())),
  );

  private lastLoggedStage: string | null = null;

  ngOnInit(): void {
    this.loadHistory();

    // Tick once a second so `elapsed` updates while a job is running.
    interval(1000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.now.set(Date.now());
        this.trackStageTransition();
      });
  }

  protected stageLabelFor(stage: ScrapeStage | null): string {
    return stage ? STAGE_LABELS[stage] : '—';
  }

  protected runScrape(): void {
    this.starting.set(true);
    this.actionError.set(null);
    this.api
      .startScrape()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (job) => {
          this.starting.set(false);
          this.monitor.track(job);
          this.loadHistory();
        },
        error: (error: unknown) => {
          this.starting.set(false);
          const message = messageOf(error);
          this.actionError.set(message);
          // 409: a job is already running — adopt the newest running job instead.
          if (/already running/i.test(message)) {
            this.adoptRunningJob();
          }
        },
      });
  }

  protected refreshData(): void {
    this.loadHistory();
    // Tell other screens (leaderboard/funds/signals) to refetch their read models.
    this.dataRefresh.requestRefresh();
  }

  protected loadHistory(): void {
    this.historyState.set('loading');
    this.historyError.set(null);
    this.api
      .listJobs(JOB_HISTORY_LIMIT)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (jobs) => {
          this.history.set(jobs);
          this.historyState.set(jobs.length === 0 ? 'empty' : 'success');
        },
        error: (error: unknown) => {
          this.historyError.set(messageOf(error));
          this.historyState.set('error');
        },
      });
  }

  private adoptRunningJob(): void {
    this.api
      .listJobs(JOB_HISTORY_LIMIT)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (jobs) => {
          this.history.set(jobs);
          const running = jobs.find((job) => job.status === 'queued' || job.status === 'running');
          if (running) {
            this.monitor.track(running);
          }
        },
      });
  }

  private trackStageTransition(): void {
    const job = this.job();
    if (!job) {
      return;
    }
    const key = `${job.id}:${job.status}:${job.stage ?? ''}`;
    if (key === this.lastLoggedStage) {
      return;
    }
    this.lastLoggedStage = key;
    const time = new Date().toLocaleTimeString();
    this.log.update((lines) =>
      [`[${time}] Job #${job.id} · ${job.status} · ${job.stage ?? '—'}`, ...lines].slice(0, 20),
    );
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}
