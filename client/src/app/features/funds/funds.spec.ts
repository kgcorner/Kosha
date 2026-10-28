import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { errorInterceptor } from '../../core/error.interceptor';
import { Fund } from '../../core/models/fund';
import { Funds } from './funds';

function fund(partial: Partial<Fund>): Fund {
  return {
    id: 1,
    name: 'Axis Bluechip Fund',
    category: 'Large Cap',
    url: 'https://groww.in/mutual-funds/axis-bluechip-fund',
    last_scraped_at: '2026-10-15 06:00:00',
    ...partial,
  };
}

describe('Funds', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [Funds],
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

  function createWithFunds(funds: Fund[]) {
    const fixture = TestBed.createComponent(Funds);
    fixture.detectChanges();
    http.expectOne('/api/funds').flush(funds);
    fixture.detectChanges();
    return fixture;
  }

  it('renders a row per fund', () => {
    const fixture = createWithFunds([
      fund({ id: 1, name: 'Axis Bluechip Fund' }),
      fund({ id: 2, name: 'HDFC Flexi Cap Fund', category: 'Flexi Cap' }),
    ]);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('Axis Bluechip Fund');
    expect(text).toContain('HDFC Flexi Cap Fund');
  });

  it('shows the empty state when there are no funds', () => {
    const fixture = createWithFunds([]);

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No funds tracked yet');
  });

  it('shows an error message when the request fails', () => {
    const fixture = TestBed.createComponent(Funds);
    fixture.detectChanges();
    http
      .expectOne('/api/funds')
      .flush({ error: 'Funds table missing' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Funds table missing');
  });

  it('flags a fund that has never been scraped', () => {
    const fixture = createWithFunds([fund({ last_scraped_at: null })]);

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Never scraped');
  });

  it('flags a fund scraped beyond the 26-hour freshness window', () => {
    const fixture = createWithFunds([fund({ last_scraped_at: '2000-01-01 00:00:00' })]);

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Needs refresh');
  });

  it('marks a recently scraped fund as up to date', () => {
    // Backend timestamps are UTC (SQLite CURRENT_TIMESTAMP).
    const recent = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const fixture = createWithFunds([fund({ last_scraped_at: recent })]);

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Up to date');
  });

  it('renders a safe external link with rel="noopener noreferrer"', () => {
    const fixture = createWithFunds([fund({ url: 'https://groww.in/mutual-funds/axis' })]);
    const link = (fixture.nativeElement as HTMLElement).querySelector(
      'a[href^="https://groww.in"]',
    );

    expect(link).not.toBeNull();
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(link?.getAttribute('rel')).toContain('noreferrer');
  });

  it('filters funds by category', () => {
    const fixture = createWithFunds([
      fund({ id: 1, name: 'Axis Bluechip Fund', category: 'Large Cap' }),
      fund({ id: 2, name: 'HDFC Flexi Cap Fund', category: 'Flexi Cap' }),
    ]);

    const select = (fixture.nativeElement as HTMLElement).querySelector(
      'select',
    ) as HTMLSelectElement;
    select.value = 'Flexi Cap';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('HDFC Flexi Cap Fund');
    expect(text).not.toContain('Axis Bluechip Fund');
  });
});
