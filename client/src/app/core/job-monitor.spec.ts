import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { errorInterceptor } from './error.interceptor';
import { ACTIVE_JOB_STORAGE_KEY, JobMonitorService } from './job-monitor';
import { ScrapeJob } from './models/scrape-job';

function job(partial: Partial<ScrapeJob>): ScrapeJob {
  return {
    id: 1,
    status: 'running',
    stage: 'discovering_funds',
    created_at: '2026-10-15 06:00:00',
    started_at: '2026-10-15 06:00:01',
    finished_at: null,
    funds_found: null,
    stocks: null,
    error: null,
    result: null,
    ...partial,
  };
}

/** Let RXJS `timer(0, …)` fire so the first poll request is actually issued. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('JobMonitorService', () => {
  let service: JobMonitorService;
  let http: HttpTestingController;

  function configure(): void {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    service = TestBed.inject(JobMonitorService);
    http = TestBed.inject(HttpTestingController);
  }

  beforeEach(() => {
    localStorage.clear();
    configure();
  });

  afterEach(() => {
    try {
      service.stop();
      http.verify();
    } finally {
      localStorage.clear();
      TestBed.resetTestingModule();
    }
  });

  it('tracks a 202 job, persists its id and starts polling', async () => {
    service.track(job({ id: 9, status: 'queued', stage: null }));

    expect(service.isRunning()).toBe(true);
    expect(service.job()?.id).toBe(9);
    expect(localStorage.getItem(ACTIVE_JOB_STORAGE_KEY)).toBe('9');

    await settle();
    http.expectOne('/api/jobs/9').flush(job({ id: 9 }));
  });

  it('stops polling immediately for a terminal job', () => {
    service.track(job({ id: 3, status: 'completed', stage: 'completed' }));

    expect(service.isRunning()).toBe(false);
    expect(service.canStart()).toBe(true);
    expect(service.isPolling()).toBe(false);
    http.expectNone('/api/jobs/3');
  });

  it('marks the job stale and clears storage when the API returns 404', async () => {
    service.track(job({ id: 5 }));

    await settle();
    http
      .expectOne('/api/jobs/5')
      .flush({ error: 'Scrape job #5 not found' }, { status: 404, statusText: 'Not Found' });

    expect(service.isStale()).toBe(true);
    expect(service.job()).toBeNull();
    expect(service.isRunning()).toBe(false);
    expect(localStorage.getItem(ACTIVE_JOB_STORAGE_KEY)).toBeNull();
  });

  it('resumes a persisted job on construction', async () => {
    // The service is a singleton per TestBed, so persist the id before it is
    // first constructed: reset the module, seed storage, then re-inject.
    service.stop();
    TestBed.resetTestingModule();
    localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, '12');
    configure();

    // `resume()` fetches immediately (no timer), so the request is already in flight.
    await settle();
    http.expectOne('/api/jobs/12').flush(job({ id: 12 }));
    expect(service.job()?.id).toBe(12);
  });

  it('ignores a garbage persisted id', () => {
    service.stop();
    TestBed.resetTestingModule();
    localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, 'not-a-number');
    configure();

    expect(service.isPolling()).toBe(false);
    http.expectNone('/api/jobs/NaN');
  });

  it('derives a coarse progress percentage from the stage order', async () => {
    service.track(job({ id: 21, stage: 'scraping_holdings' }));

    await settle();
    http.expectOne('/api/jobs/21').flush(job({ id: 21, stage: 'scraping_holdings' }));

    expect(service.progress()).toBe(50);
    expect(service.stageLabel()).toBe('Scraping holdings');
    expect(service.statusLabel()).toBe('Running');
  });

  it('reports 100% for a completed job', () => {
    service.track(job({ id: 22, status: 'completed', stage: 'completed' }));
    expect(service.progress()).toBe(100);
  });

  it('reset() clears the job and the persisted id', async () => {
    service.track(job({ id: 30 }));

    await settle();
    http.expectOne('/api/jobs/30').flush(job({ id: 30 }));
    service.reset();

    expect(service.job()).toBeNull();
    expect(localStorage.getItem(ACTIVE_JOB_STORAGE_KEY)).toBeNull();
  });
});
