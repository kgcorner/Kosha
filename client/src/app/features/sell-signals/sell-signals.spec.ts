import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { errorInterceptor } from '../../core/error.interceptor';
import { FOLLOWED_CATEGORIES_STORAGE_KEY } from '../../core/sell-signals';
import { SellSignals } from './sell-signals';

const FALLBACK_CATEGORIES = [
  'Mid Cap',
  'Large Cap',
  'Small Cap',
  'ELSS',
  'Thematic',
  'Value Oriented',
  'Flexi Cap',
];

function changes(category: string, removed: string[], added = '') {
  return {
    category,
    run_id: 4,
    run_at: '2026-10-15 06:00:00',
    removed: removed.map((name, index) => ({ stock_id: index + 1, name })),
    added: added ? [{ stock_id: 99, name: added }] : [],
  };
}

function emptyChanges(category: string) {
  return { category, run_id: null, run_at: null, removed: [], added: [] };
}

function fund(id: number, category: string) {
  return {
    id,
    name: `Fund ${id}`,
    url: `https://groww.in/mutual-funds/fund-${id}`,
    category,
    last_scraped_at: null,
  };
}

describe('SellSignals', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [SellSignals],
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

  /** Create the component and answer the funds-derived category loads. */
  function create(answers: Record<string, object>) {
    const fixture = TestBed.createComponent(SellSignals);
    fixture.detectChanges();

    const categories = Object.keys(answers);
    http
      .expectOne('/api/funds')
      .flush(categories.map((category, index) => fund(index + 1, category)));

    for (const category of categories) {
      http
        .expectOne(`/api/categories/${encodeURIComponent(category)}/changes`)
        .flush(answers[category]);
    }
    fixture.detectChanges();
    return fixture;
  }

  function body(fixture: { nativeElement: unknown }): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  it('discovers categories from funds and renders one card per followed category', () => {
    const fixture = create({
      'Flexi Cap': changes('Flexi Cap', []),
      'Large Cap': changes('Large Cap', []),
    });

    expect(body(fixture)).toContain('Flexi Cap');
    expect(body(fixture)).toContain('Large Cap');
  });

  it('renders removed stocks as sell signals', () => {
    const fixture = create({
      'Flexi Cap': changes('Flexi Cap', []),
      'Large Cap': changes('Large Cap', ['Infosys']),
    });

    const text = body(fixture);
    expect(text).toContain('Infosys');
    expect(text).toContain('Sell signals (removed)');
    expect(text).toContain('consider selling');
  });

  it('hides excluded parser junk from sell signals and totals', () => {
    const fixture = create({
      'Large Cap': changes('Large Cap', ['Net Payables', 'Infosys', 'Repo'], 'Repo'),
    });

    const text = body(fixture);
    expect(text).toContain('Infosys');
    expect(text).not.toContain('Net Payables');
    expect(text).not.toContain('Repo');
    expect(text).toContain('1 removed');
    expect(text).not.toContain('1 added');
  });

  it('renders added stocks as informational entries', () => {
    const fixture = create({
      'Flexi Cap': changes('Flexi Cap', []),
      'Large Cap': changes('Large Cap', [], 'TCS'),
    });

    const text = body(fixture);
    expect(text).toContain('TCS');
    expect(text).toContain('Added (informational)');
  });

  it('shows an empty-history message when the category has never run', () => {
    const fixture = create({
      'Flexi Cap': changes('Flexi Cap', []),
      'Large Cap': emptyChanges('Large Cap'),
    });

    expect(body(fixture)).toContain('No changes recorded for this category');
  });

  it('summarises the totals across followed categories', () => {
    const fixture = create({
      'Flexi Cap': changes('Flexi Cap', ['Wipro'], 'TCS'),
      'Large Cap': changes('Large Cap', ['Infosys', 'SBI']),
    });

    const text = body(fixture);
    expect(text).toContain('3 removed');
    expect(text).toContain('1 added');
  });

  it('isolates a single category failure without blanking the page', () => {
    const fixture = TestBed.createComponent(SellSignals);
    fixture.detectChanges();
    http.expectOne('/api/funds').flush([fund(1, 'Large Cap'), fund(2, 'Flexi Cap')]);
    http.expectOne('/api/categories/Flexi%20Cap/changes').flush(changes('Flexi Cap', []));
    http
      .expectOne('/api/categories/Large%20Cap/changes')
      .flush({ error: 'Category lookup failed' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    const text = body(fixture);
    expect(text).toContain('Category lookup failed');
    expect(text).toContain('Flexi Cap');
  });

  it('unfollowing a category hides its card and persists the remaining selection', () => {
    const fixture = create({
      'Flexi Cap': changes('Flexi Cap', []),
      'Large Cap': changes('Large Cap', ['Infosys']),
    });

    const followButton = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ].find(
      (button) =>
        button.closest('.signal-card')?.textContent?.includes('Large Cap') &&
        button.textContent?.includes('Following'),
    ) as HTMLButtonElement;
    followButton.click();

    // Only the still-followed category is requested again.
    http.expectOne('/api/categories/Flexi%20Cap/changes').flush(changes('Flexi Cap', []));
    fixture.detectChanges();

    expect(body(fixture)).not.toContain('Infosys');
    expect(JSON.parse(localStorage.getItem(FOLLOWED_CATEGORIES_STORAGE_KEY) ?? '[]')).toEqual([
      'Flexi Cap',
    ]);
  });

  it('falls back to the canonical seven categories when no funds are tracked', () => {
    const fixture = TestBed.createComponent(SellSignals);
    fixture.detectChanges();
    http.expectOne('/api/funds').flush([]);

    for (const category of FALLBACK_CATEGORIES) {
      http
        .expectOne(`/api/categories/${encodeURIComponent(category)}/changes`)
        .flush(changes(category, []));
    }
    fixture.detectChanges();

    expect(body(fixture)).toContain('Mid Cap');
    expect(body(fixture)).toContain('Value Oriented');
  });

  it('shows the empty state when the user follows no categories', () => {
    localStorage.setItem(FOLLOWED_CATEGORIES_STORAGE_KEY, '[]');
    const fixture = TestBed.createComponent(SellSignals);
    fixture.detectChanges();
    http.expectOne('/api/funds').flush([fund(1, 'Large Cap')]);
    fixture.detectChanges();

    expect(body(fixture)).toContain('No categories to follow yet');
  });

  it('falls back to the static categories when category discovery fails', () => {
    const fixture = TestBed.createComponent(SellSignals);
    fixture.detectChanges();
    http
      .expectOne('/api/funds')
      .flush({ error: 'Funds unavailable' }, { status: 500, statusText: 'Server Error' });

    for (const category of FALLBACK_CATEGORIES) {
      http
        .expectOne(`/api/categories/${encodeURIComponent(category)}/changes`)
        .flush(changes(category, []));
    }
    fixture.detectChanges();

    expect(body(fixture)).toContain('Large Cap');
  });
});
