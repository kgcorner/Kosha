import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ApiService } from './api';
import { CategoryChanges } from './models/category-changes';
import { Fund } from './models/fund';
import { LeaderboardRow } from './models/leaderboard-row';
import { ScrapeJob } from './models/scrape-job';

describe('ApiService', () => {
  let service: ApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('requests the leaderboard with limit and offset query params', () => {
    const rows: LeaderboardRow[] = [];
    service
      .getLeaderboard({ limit: 20, offset: 40 })
      .subscribe((result) => expect(result).toEqual(rows));

    const request = http.expectOne((req) => req.url === '/api/stocks/leaderboard');
    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('limit')).toBe('20');
    expect(request.request.params.get('offset')).toBe('40');
    request.flush(rows);
  });

  it('clamps limit above 100 and offset below 0', () => {
    service.getLeaderboard({ limit: 500, offset: -10 }).subscribe();
    const request = http.expectOne((req) => req.url === '/api/stocks/leaderboard');
    expect(request.request.params.get('limit')).toBe('100');
    expect(request.request.params.get('offset')).toBe('0');
    request.flush([]);
  });

  it('clamps limit below 1 up to 1', () => {
    service.getLeaderboard({ limit: 0 }).subscribe();
    const request = http.expectOne((req) => req.url === '/api/stocks/leaderboard');
    expect(request.request.params.get('limit')).toBe('1');
    request.flush([]);
  });

  it('uses defaults (20 / 0) when no query is provided', () => {
    service.getLeaderboard().subscribe();
    const request = http.expectOne((req) => req.url === '/api/stocks/leaderboard');
    expect(request.request.params.get('limit')).toBe('20');
    expect(request.request.params.get('offset')).toBe('0');
    request.flush([]);
  });

  it('adds the category param only when a category is provided', () => {
    service.getLeaderboard({ category: 'Small Cap' }).subscribe();
    const scoped = http.expectOne((req) => req.url === '/api/stocks/leaderboard');
    expect(scoped.request.params.get('category')).toBe('Small Cap');
    scoped.flush([]);

    service.getLeaderboard().subscribe();
    const unscoped = http.expectOne((req) => req.url === '/api/stocks/leaderboard');
    expect(unscoped.request.params.has('category')).toBe(false);
    unscoped.flush([]);
  });

  it('fetches the distinct categories for the filter', () => {
    service.getCategories().subscribe((result) => expect(result).toEqual(['Large Cap']));
    const request = http.expectOne('/api/categories');
    expect(request.request.method).toBe('GET');
    request.flush(['Large Cap']);
  });

  it('fetches funds from the relative /api path', () => {
    const funds: Fund[] = [];
    service.getFunds().subscribe((result) => expect(result).toEqual(funds));
    const request = http.expectOne('/api/funds');
    expect(request.request.method).toBe('GET');
    request.flush(funds);
  });

  it('posts to /api/jobs/scrape without a body', () => {
    const job = { id: 1 } as ScrapeJob;
    service.startScrape().subscribe((result) => expect(result).toEqual(job));
    const request = http.expectOne('/api/jobs/scrape');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toBeNull();
    request.flush(job, { status: 202, statusText: 'Accepted' });
  });

  it('lists jobs with a clamped limit', () => {
    service.listJobs(500).subscribe();
    const request = http.expectOne((req) => req.url === '/api/jobs');
    expect(request.request.params.get('limit')).toBe('100');
    request.flush([]);
  });

  it('fetches a single job by id', () => {
    service.getJob(7).subscribe();
    const request = http.expectOne('/api/jobs/7');
    expect(request.request.method).toBe('GET');
    request.flush({ id: 7 } as ScrapeJob);
  });

  it('URL-encodes the category when fetching changes', () => {
    const changes = { category: 'Flexi Cap' } as CategoryChanges;
    service.getCategoryChanges('Flexi Cap').subscribe((result) => expect(result).toEqual(changes));

    const request = http.expectOne('/api/categories/Flexi%20Cap/changes');
    expect(request.request.method).toBe('GET');
    request.flush(changes);
  });
});
