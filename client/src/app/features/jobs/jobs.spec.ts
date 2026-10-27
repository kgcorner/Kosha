import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { DataRefreshService } from '../../core/data-refresh';
import { errorInterceptor } from '../../core/error.interceptor';
import { ACTIVE_JOB_STORAGE_KEY, JobMonitorService } from '../../core/job-monitor';
import { ScrapeJob } from '../../core/models/scrape-job';
import { Jobs } from './jobs';

function job(partial: Partial<ScrapeJob>): ScrapeJob {
  return {
    id: 1,
    status: 'running',
    stage: 'discovering_funds',
    funds_found: null,
    stocks: null,
    result: null,
    error: null,
    created_at: '2026-10-15 06:00:00',
    started_at: '2026-10-15 06:00:00',
    finished_at: null,
    ...partial,
  };
}

/** Let RXJS `timer(0, …)` fire so the first poll request is actually issued. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Jobs', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [Jobs],
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    try {
      TestBed.inject(JobMonitorService).stop();
      http.verify();
    } finally {
      localStorage.clear();
      TestBed.resetTestingModule();
    }
  });

  function create() {
    const fixture = TestBed.createComponent(Jobs);
    fixture.detectChanges();
    return fixture;
  }

  it('loads and renders the job history', () => {
    const fixture = create();
    http
      .expectOne((req) => req.url === '/api/jobs')
      .flush([
        job({ id: 7, status: 'completed', stage: 'completed', finished_at: '2026-10-15 06:05:00' }),
      ]);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Recent jobs');
    expect(text).toContain('7');
    expect(text).toContain('completed');
  });

  it('requests the 20-job history limit', () => {
    create();
    const request = http.expectOne((req) => req.url === '/api/jobs');
    expect(request.request.params.get('limit')).toBe('20');
    request.flush([]);
  });

  it('shows the empty history state', () => {
    const fixture = create();
    http.expectOne((req) => req.url === '/api/jobs').flush([]);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No scrape jobs yet');
  });

  it('shows the history error state with a working retry', () => {
    const fixture = create();
    http
      .expectOne((req) => req.url === '/api/jobs')
      .flush({ error: 'Jobs table locked' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Jobs table locked');

    const retry = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
      (button) => button.textContent?.includes('Retry'),
    ) as HTMLButtonElement;
    retry.click();
    http.expectOne((req) => req.url === '/api/jobs').flush([]);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No scrape jobs yet');
  });

  it('starts a scrape on click and adopts the returned job for monitoring', () => {
    const fixture = create();
    http.expectOne((req) => req.url === '/api/jobs').flush([]);
    fixture.detectChanges();

    const run = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
      (button) => button.textContent?.includes('Run scrape'),
    ) as HTMLButtonElement;
    run.click();

    http.expectOne('/api/jobs/scrape').flush(job({ id: 11, status: 'queued', stage: null }), {
      status: 202,
      statusText: 'Accepted',
    });
    // History refreshes after a successful start.
    http
      .expectOne((req) => req.url === '/api/jobs')
      .flush([job({ id: 11, status: 'queued', stage: null })]);
    fixture.detectChanges();

    expect(localStorage.getItem(ACTIVE_JOB_STORAGE_KEY)).toBe('11');
  });

  it('surfaces a 409 verbatim and adopts the already-running job', async () => {
    const fixture = create();
    http.expectOne((req) => req.url === '/api/jobs').flush([]);
    fixture.detectChanges();

    const run = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
      (button) => button.textContent?.includes('Run scrape'),
    ) as HTMLButtonElement;
    run.click();

    http
      .expectOne('/api/jobs/scrape')
      .flush(
        { error: 'A scrape job is already running (job #4)' },
        { status: 409, statusText: 'Conflict' },
      );
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'A scrape job is already running (job #4)',
    );

    // The adopt path lists jobs and picks the running one.
    http
      .expectOne((req) => req.url === '/api/jobs')
      .flush([job({ id: 4, status: 'running', stage: 'aggregating' })]);
    fixture.detectChanges();

    // Monitoring started, so the poll immediately hits GET /api/jobs/4.
    await settle();
    http.expectOne('/api/jobs/4').flush(job({ id: 4, status: 'running', stage: 'aggregating' }));
    expect(localStorage.getItem(ACTIVE_JOB_STORAGE_KEY)).toBe('4');
  });

  it('disables the Run scrape button while a job is running', () => {
    localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, '2');
    const fixture = create();
    http.expectOne((req) => req.url === '/api/jobs').flush([]);
    http
      .expectOne('/api/jobs/2')
      .flush(job({ id: 2, status: 'running', stage: 'scraping_holdings' }));
    fixture.detectChanges();

    const run = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
      (button) => button.textContent?.includes('Scrape running'),
    ) as HTMLButtonElement;

    expect(run).toBeDefined();
    expect(run.disabled).toBe(true);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Scraping holdings');
  });

  it('renders the completed result summary and broadcasts a refresh', () => {
    const fixture = create();
    http.expectOne((req) => req.url === '/api/jobs').flush([]);
    fixture.detectChanges();

    const monitor = TestBed.inject(JobMonitorService);
    const refreshService = TestBed.inject(DataRefreshService);
    const before = refreshService.token();

    monitor.track(
      job({
        id: 9,
        status: 'completed',
        stage: 'completed',
        finished_at: '2026-10-15 06:10:00',
        result: { funds: 12, stocks: 340, changes: { added: 5, removed: 3 } },
      }),
    );
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Scrape completed');
    expect(text).toContain('12 fund(s), 340 stock(s) · 5 added, 3 removed');

    const refresh = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
      (button) => button.textContent?.includes('Refresh data'),
    ) as HTMLButtonElement;
    refresh.click();
    http.expectOne((req) => req.url === '/api/jobs').flush([]);

    expect(refreshService.token()).toBe(before + 1);
  });

  it('renders the failed result with the recorded error', () => {
    const fixture = create();
    http.expectOne((req) => req.url === '/api/jobs').flush([]);
    fixture.detectChanges();

    const monitor = TestBed.inject(JobMonitorService);
    monitor.track(
      job({
        id: 5,
        status: 'failed',
        stage: 'failed',
        finished_at: '2026-10-15 06:07:00',
        error: 'Groww returned 503',
      }),
    );
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Scrape failed');
    expect(text).toContain('Groww returned 503');
  });
});
