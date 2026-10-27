import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { ApiError, errorInterceptor } from './error.interceptor';

describe('errorInterceptor', () => {
  let client: HttpClient;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    client = TestBed.inject(HttpClient);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('maps a backend { error } body to ApiError carrying the message', () => {
    let captured: unknown;
    client
      .get('/api/jobs/1', { observe: 'body' })
      .subscribe({ error: (e: unknown) => (captured = e) });

    http
      .expectOne('/api/jobs/1')
      .flush({ error: 'Scrape job #1 not found' }, { status: 404, statusText: 'Not Found' });

    expect(captured).toBeInstanceOf(ApiError);
    expect((captured as ApiError).status).toBe(404);
    expect((captured as ApiError).message).toBe('Scrape job #1 not found');
  });

  it('keeps a 409 message intact so features render it verbatim', () => {
    let captured: unknown;
    client.post('/api/jobs/scrape', null).subscribe({ error: (e: unknown) => (captured = e) });

    http
      .expectOne('/api/jobs/scrape')
      .flush(
        { error: 'A scrape job is already running (job #4)' },
        { status: 409, statusText: 'Conflict' },
      );

    expect(captured).toBeInstanceOf(ApiError);
    expect((captured as ApiError).message).toBe('A scrape job is already running (job #4)');
  });

  it('keeps a 400 pagination message intact', () => {
    let captured: unknown;
    client.get('/api/stocks/leaderboard').subscribe({ error: (e: unknown) => (captured = e) });

    http
      .expectOne('/api/stocks/leaderboard')
      .flush(
        { error: 'Pagination parameters must be non-negative integers' },
        { status: 400, statusText: 'Bad Request' },
      );

    expect((captured as ApiError).message).toBe(
      'Pagination parameters must be non-negative integers',
    );
  });

  it('produces a readable message for a non-JSON error body', () => {
    let captured: unknown;
    client.get('/api/funds').subscribe({ error: (e: unknown) => (captured = e) });

    http.expectOne('/api/funds').error(new ProgressEvent('error'), { status: 0 });

    expect(captured).toBeInstanceOf(ApiError);
    expect((captured as ApiError).message).toContain('Unable to reach the server');
    expect((captured as ApiError).message).not.toContain('[object Object]');
  });

  it('falls back to a status-based message for an unknown body shape', () => {
    let captured: unknown;
    client.get('/api/funds').subscribe({ error: (e: unknown) => (captured = e) });

    http
      .expectOne('/api/funds')
      .flush({ unexpected: true }, { status: 500, statusText: 'Server Error' });

    expect(captured).toBeInstanceOf(ApiError);
    expect((captured as ApiError).message).toContain('500');
  });
});
