import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { errorInterceptor } from '../../core/error.interceptor';
import { StockDetail as StockDetailModel } from '../../core/models/stock-detail';
import { StockFundamentals } from '../../core/models/stock-fundamentals';
import { StockDetail } from './stock-detail';

function detail(partial: Partial<StockDetailModel> = {}): StockDetailModel {
  return {
    stock: {
      id: 7,
      name: 'Karur Vysya Bank Ltd.',
      isin: 'INE036D01028',
      symbol: null,
      sector: 'Banks',
      url: null,
    },
    totals: {
      funds_holding: 2,
      total_quantity: 1500,
      total_market_value_cr: 37.75,
      latest_as_of: '2026-09-30',
    },
    holdings: [
      {
        fund_id: 1,
        fund_name: 'Alpha Small Cap Fund',
        category: 'Small Cap',
        weight_percentage: 2.5,
        quantity: 1000,
        market_value_cr: 25.5,
        as_of: '2026-09-30',
      },
      {
        fund_id: 2,
        fund_name: 'Beta Flexi Cap Fund',
        category: 'Flexi Cap',
        weight_percentage: 1.5,
        quantity: 500,
        market_value_cr: 12.25,
        as_of: '2026-09-30',
      },
    ],
    recent_changes: [
      { category: 'Small Cap', change_type: 'removed', run_at: '2026-10-27 15:56:35', run_id: 2 },
    ],
    fundamentals_cached: [],
    fund_signal: {
      funds_holding: 2,
      rank: 3,
      weight_avg: 2,
      weight_min: 1.5,
      weight_max: 2.5,
      categories: [
        { category: 'Small Cap', funds_holding: 1, funds_in_category: 4, weight_avg: 2.5 },
      ],
    },
    ...partial,
  };
}

function fundamentals(partial: Partial<StockFundamentals> = {}): StockFundamentals {
  return {
    stock: { id: 7, name: 'Karur Vysya Bank Ltd.', isin: 'INE036D01028', symbol: 'KARURVYSYA' },
    provider: 'tapetide',
    fund_signal: detail().fund_signal,
    fundamentals: {
      profile: {
        data: { pe_ratio: 9.8, roe: 17.2 },
        fetched_at: '2026-10-28 03:40:00',
        provider: 'tapetide',
        cached: false,
        stale: false,
      },
      pledge: {
        data: { pledged_pct: 0 },
        fetched_at: '2026-10-27 03:40:00',
        provider: 'tapetide',
        cached: true,
        stale: true,
      },
    },
    errors: [
      {
        section: 'pledge',
        code: 'rate_limited',
        message: 'Tapetide rate limit or daily quota reached',
        retry_after_seconds: 60,
      },
    ],
    ...partial,
  };
}

describe('StockDetail', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [StockDetail],
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  function create(stockId = '7') {
    const fixture = TestBed.createComponent(StockDetail);
    fixture.componentRef.setInput('stockId', stockId);
    fixture.detectChanges();
    return fixture;
  }

  it('loads the stored detail without calling for fundamentals', async () => {
    const fixture = create();
    http.expectOne('/api/stocks/7').flush(detail());
    await fixture.whenStable();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Karur Vysya Bank Ltd.');
    expect(text).toContain('ISIN INE036D01028');
    expect(text).toContain('Alpha Small Cap Fund');
    expect(text).toContain('1 / 4');
    expect(text).toContain('25%');
    expect(text).toContain('Removed from');
    expect(text).toContain('Fetch fundamentals');
    http.expectNone((request) => request.url.includes('/fundamentals'));
  });

  it('fetches fundamentals on click and shows sections, freshness and provider errors', async () => {
    const fixture = create();
    http.expectOne('/api/stocks/7').flush(detail());
    await fixture.whenStable();
    fixture.detectChanges();

    const button = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).find((b) => b.textContent?.includes('Fetch fundamentals')) as HTMLButtonElement;
    button.click();
    fixture.detectChanges();
    expect(button.disabled).toBe(true);

    http.expectOne('/api/stocks/7/fundamentals').flush(fundamentals());
    await fixture.whenStable();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Company profile');
    expect(text).toContain('PE ratio');
    expect(text).toContain('Promoter pledge');
    expect(text).toContain('Stale');
    expect(text).toContain('Tapetide rate limit or daily quota reached');
    expect(text).toContain('1 section(s) fetched from tapetide just now');
    expect(text).toContain('NSE: KARURVYSYA');
    expect(text).toContain('Fetch again');
  });

  it('shows an error for an invalid id without calling the API', async () => {
    const fixture = create('abc');
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('not a valid stock id');
  });

  it('shows the backend error when the stock does not exist', async () => {
    const fixture = create('999');
    http
      .expectOne('/api/stocks/999')
      .flush({ error: 'Stock #999 not found' }, { status: 404, statusText: 'Not Found' });
    await fixture.whenStable();
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Couldn’t load this stock');
  });
});
