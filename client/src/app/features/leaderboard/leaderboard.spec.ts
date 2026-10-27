import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { errorInterceptor } from '../../core/error.interceptor';
import { LeaderboardRow } from '../../core/models/leaderboard-row';
import { Leaderboard } from './leaderboard';

function row(partial: Partial<LeaderboardRow>): LeaderboardRow {
  return {
    stock_id: 1,
    name: 'HDFC Bank',
    consensus_score: 5,
    total_weight_sum: 0,
    weight_avg: null,
    weight_min: null,
    weight_max: null,
    rank: 1,
    stock_url: 'https://groww.in/stocks/hdfc-bank-ltd',
    metrics: null,
    categories: [],
    thesis: null,
    pros: [],
    cons: [],
    last_analyzed_at: '2026-10-15 06:00:00',
    ...partial,
  };
}

describe('Leaderboard', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [Leaderboard],
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
      http.verify();
    } finally {
      localStorage.clear();
      TestBed.resetTestingModule();
    }
  });

  /** Answer the funds call that `ngOnInit` uses to discover categories. */
  function flushInit(removedByName: Record<string, string> = {}): void {
    const categories = Object.keys(removedByName);
    const names = categories.length > 0 ? categories : ['Large Cap'];

    // The leaderboard's own category filter list (independent of sell signals).
    http.expectOne('/api/categories').flush(names);

    http.expectOne('/api/funds').flush(
      names.map((category, index) => ({
        id: index + 1,
        name: `Fund ${index + 1}`,
        url: `https://groww.in/mutual-funds/fund-${index + 1}`,
        category,
        last_scraped_at: null,
      })),
    );

    // Categories are discovered synchronously after the funds response, so their
    // change requests are already registered by the time we answer them.
    for (const category of names) {
      const removed = removedByName[category];
      http.expectOne(`/api/categories/${encodeURIComponent(category)}/changes`).flush({
        category,
        run_id: removed ? 1 : null,
        run_at: removed ? '2026-10-15 06:00:00' : null,
        removed: removed ? [{ stock_id: 2, name: removed }] : [],
        added: [],
      });
    }
  }

  function createWithRows(rows: LeaderboardRow[], categories: string[] = ['Large Cap']) {
    const fixture = TestBed.createComponent(Leaderboard);
    fixture.detectChanges();
    flushInit(Object.fromEntries(categories.map((category) => [category, ''])));
    http.expectOne((req) => req.url === '/api/stocks/leaderboard').flush(rows);
    fixture.detectChanges();
    return fixture;
  }

  it('renders rows returned by the API', () => {
    const fixture = createWithRows([row({ name: 'Infosys', stock_id: 2, rank: 1 })]);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('Infosys');
    expect(text).toContain('Consensus leaderboard');
  });

  it('requests the default page size of 20 with offset 0', () => {
    const fixture = TestBed.createComponent(Leaderboard);
    fixture.detectChanges();
    flushInit();

    const request = http.expectOne((req) => req.url === '/api/stocks/leaderboard');
    expect(request.request.params.get('limit')).toBe('20');
    expect(request.request.params.get('offset')).toBe('0');
    request.flush([]);
  });

  it('shows the empty state when the API returns no rows', () => {
    const fixture = createWithRows([]);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('No consensus data yet');
  });

  it('shows an inline error and retries via the Retry button', () => {
    const fixture = TestBed.createComponent(Leaderboard);
    fixture.detectChanges();
    flushInit();
    http
      .expectOne((req) => req.url === '/api/stocks/leaderboard')
      .flush({ error: 'Database unavailable' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Database unavailable');

    const retry = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
      (button) => button.textContent?.includes('Retry'),
    );
    retry?.click();
    http.expectOne((req) => req.url === '/api/stocks/leaderboard').flush([]);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No consensus data yet');
  });

  it('renders an em dash when no fund publishes a parsable weight', () => {
    const fixture = createWithRows([row({ weight_avg: null, weight_min: null, weight_max: null })]);
    const table = (fixture.nativeElement as HTMLElement).querySelector('table');
    const weightCell = table?.querySelectorAll('tbody tr td')[4];

    expect(weightCell?.textContent?.trim()).toBe('—');
  });

  it('renders the average per-fund weight with its min–max range', () => {
    const fixture = createWithRows([row({ weight_avg: 1.24, weight_min: 0.4, weight_max: 3.1 })]);
    const table = (fixture.nativeElement as HTMLElement).querySelector('table');
    const weightCell = table?.querySelectorAll('tbody tr td')[4];

    expect(weightCell?.textContent?.trim()).toBe('1.24% (0.4–3.1%)');
  });

  it('renders only the average when every fund weights the stock equally', () => {
    const fixture = createWithRows([row({ weight_avg: 2, weight_min: 2, weight_max: 2 })]);
    const table = (fixture.nativeElement as HTMLElement).querySelector('table');
    const weightCell = table?.querySelectorAll('tbody tr td')[4];

    expect(weightCell?.textContent?.trim()).toBe('2%');
  });

  it('renders the scraped live price, falling back to an em dash', () => {
    const withPrice = createWithRows([
      row({ metrics: { core_identifiers_and_market_metrics: { live_price: '₹728.85' } } }),
    ]);
    const pricedCell = (withPrice.nativeElement as HTMLElement).querySelectorAll('tbody tr td')[2];
    expect(pricedCell?.textContent?.trim()).toBe('₹728.85');

    const without = createWithRows([row({ metrics: null })]);
    const emptyCell = (without.nativeElement as HTMLElement).querySelectorAll('tbody tr td')[2];
    expect(emptyCell?.textContent?.trim()).toBe('—');
  });

  it('shows the scraped metrics panel in the expanded row', () => {
    const fixture = createWithRows([
      row({
        metrics: {
          core_identifiers_and_market_metrics: { market_cap: '₹12,752Cr' },
          valuation_and_fundamental_ratios: { pe_ratio: '55.29', roe: '4.10%' },
        },
      }),
    ]);

    const toggle = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button.stock-toggle',
    );
    toggle?.click();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Scraped stock metrics');
    expect(text).toContain('market cap');
    expect(text).toContain('₹12,752Cr');
    expect(text).toContain('pe ratio');
    expect(text).toContain('55.29');
  });

  it('filters rows client-side by search term', () => {
    const fixture = createWithRows([
      row({ stock_id: 1, name: 'Infosys' }),
      row({ stock_id: 2, name: 'HDFC Bank', rank: 2 }),
    ]);

    const input = (fixture.nativeElement as HTMLElement).querySelector(
      'input[type="search"]',
    ) as HTMLInputElement;
    input.value = 'infosys';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Infosys');
    expect(text).not.toContain('HDFC Bank');
  });

  it('shows the AI analysis pending fallback for unenriched rows', () => {
    const fixture = createWithRows([row({ thesis: null, pros: [], cons: [] })]);

    const toggle = (fixture.nativeElement as HTMLElement).querySelector(
      '.stock-toggle',
    ) as HTMLButtonElement;
    toggle.click();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('AI analysis pending');
  });

  it('expands pros and cons when enrichment exists', () => {
    const fixture = createWithRows([
      row({ thesis: 'Strong franchise', pros: ['Low NPAs'], cons: ['Rich valuation'] }),
    ]);

    const toggle = (fixture.nativeElement as HTMLElement).querySelector(
      '.stock-toggle',
    ) as HTMLButtonElement;
    toggle.click();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Strong franchise');
    expect(text).toContain('Low NPAs');
    expect(text).toContain('Rich valuation');
  });

  it('badges a row that appears in a followed category sell signal', () => {
    const fixture = TestBed.createComponent(Leaderboard);
    fixture.detectChanges();
    flushInit({ 'Large Cap': 'Infosys' });
    http
      .expectOne((req) => req.url === '/api/stocks/leaderboard')
      .flush([row({ name: 'Infosys' })]);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Sell signal');
  });

  it('does not badge a row that is not in any removed list', () => {
    const fixture = TestBed.createComponent(Leaderboard);
    fixture.detectChanges();
    flushInit({ 'Large Cap': 'TCS' });
    http
      .expectOne((req) => req.url === '/api/stocks/leaderboard')
      .flush([row({ name: 'Infosys' })]);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Sell signal');
  });

  it('hides excluded parser junk from the rendered rows', () => {
    const fixture = createWithRows([
      row({ stock_id: 1, name: 'Net Payables', rank: 1 }),
      row({ stock_id: 2, name: 'Repo', rank: 2 }),
      row({ stock_id: 3, name: 'Infosys', rank: 3 }),
    ]);

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Infosys');
    expect(text).not.toContain('Net Payables');
    expect(text).not.toContain('Repo');
  });

  it('matches excluded names case-insensitively', () => {
    const fixture = createWithRows([row({ stock_id: 1, name: '  net payables ', rank: 1 })]);

    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('net payables');
  });

  it('shows category badges for each row', () => {
    const fixture = createWithRows([
      row({ name: 'Infosys', categories: ['Large Cap', 'Flexi Cap'] }),
    ]);

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Large Cap · Flexi Cap');
  });

  it('loads the category filter options and requests the selected category', () => {
    const fixture = TestBed.createComponent(Leaderboard);
    fixture.detectChanges();
    flushInit();
    http.expectOne((req) => req.url === '/api/stocks/leaderboard').flush([row({})]);
    fixture.detectChanges();

    const select = (fixture.nativeElement as HTMLElement).querySelector(
      'select',
    ) as HTMLSelectElement;
    const options = [...select.options].map((option) => option.value);
    expect(options).toEqual(['', 'Large Cap']);

    select.value = 'Large Cap';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const request = http.expectOne((req) => req.url === '/api/stocks/leaderboard');
    expect(request.request.params.get('category')).toBe('Large Cap');
    // Applying a filter restarts at page 1.
    expect(request.request.params.get('offset')).toBe('0');
    request.flush([row({ name: 'Infosys', rank: 1 })]);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Infosys');
  });

  it('does not send a category param for "All categories"', () => {
    const fixture = TestBed.createComponent(Leaderboard);
    fixture.detectChanges();
    flushInit();
    http.expectOne((req) => req.url === '/api/stocks/leaderboard').flush([row({})]);
    fixture.detectChanges();

    const select = (fixture.nativeElement as HTMLElement).querySelector(
      'select',
    ) as HTMLSelectElement;
    select.value = '';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const request = http.expectOne((req) => req.url === '/api/stocks/leaderboard');
    expect(request.request.params.has('category')).toBe(false);
    request.flush([row({})]);
  });

  it('disables Previous on the first page and Next on a short page', () => {
    const fixture = createWithRows([row({})]);
    const buttons = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('.pagination button'),
    ] as HTMLButtonElement[];

    const [previous, next] = buttons;
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(true);
  });

  it('enables Next on a full page and issues an offset request when clicked', () => {
    const fullPage = Array.from({ length: 20 }, (_, index) =>
      row({ stock_id: index + 1, name: `Stock ${index + 1}`, rank: index + 1 }),
    );
    const fixture = createWithRows(fullPage);

    const next = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('.pagination button'),
    ][1] as HTMLButtonElement;
    expect(next.disabled).toBe(false);

    next.click();
    const request = http.expectOne((req) => req.url === '/api/stocks/leaderboard');
    expect(request.request.params.get('offset')).toBe('20');
    request.flush([]);
  });
});
