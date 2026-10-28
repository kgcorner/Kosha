import { TestBed } from '@angular/core/testing';

import { DataView, formatScalar, humanizeKey, kindOf } from './data-view';

describe('DataView helpers', () => {
  it('classifies values by shape', () => {
    expect(kindOf(null)).toBe('empty');
    expect(kindOf('')).toBe('empty');
    expect(kindOf(12.5)).toBe('scalar');
    expect(kindOf(['a', 'b'])).toBe('list');
    expect(kindOf([{ q: 'Sep 2026', revenue: 1 }])).toBe('table');
    expect(kindOf({ pe: 9.8 })).toBe('object');
    expect(kindOf({ a: null })).toBe('empty');
    expect(kindOf({ deep: 1 }, 99)).toBe('json');
  });

  it('humanizes keys and keeps finance acronyms upper-case', () => {
    expect(humanizeKey('debt_to_equity')).toBe('Debt to equity');
    expect(humanizeKey('peRatio')).toBe('PE ratio');
    expect(humanizeKey('roce')).toBe('ROCE');
  });

  it('formats numbers with Indian grouping', () => {
    expect(formatScalar(1234567.891)).toBe('12,34,567.89');
    expect(formatScalar(true)).toBe('Yes');
    expect(formatScalar(null)).toBe('—');
  });
});

describe('DataView', () => {
  function render(value: unknown): HTMLElement {
    const fixture = TestBed.createComponent(DataView);
    fixture.componentRef.setInput('value', value);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('renders an object as label/value rows, recursing into nested objects', () => {
    const element = render({ pe_ratio: 9.8, growth: { sales_cagr_3y: 14.2 }, notes: null });
    const labels = Array.from(element.querySelectorAll('dt')).map((dt) => dt.textContent?.trim());
    expect(labels).toEqual(['PE ratio', 'Growth', 'Sales CAGR 3y']);
    expect(element.textContent).toContain('9.8');
    expect(element.textContent).toContain('14.2');
  });

  it('renders an array of records as a table', () => {
    const element = render([
      { period: 'Sep 2026', revenue: 1200 },
      { period: 'Jun 2026', revenue: 1100, profit: 90 },
    ]);
    const headers = Array.from(element.querySelectorAll('th')).map((th) => th.textContent?.trim());
    expect(headers).toEqual(['Period', 'Revenue', 'Profit']);
    expect(element.querySelectorAll('tbody tr').length).toBe(2);
    expect(element.textContent).toContain('1,200');
    const firstRow = element.querySelectorAll('tbody tr')[0].querySelectorAll('td');
    expect(firstRow[0].classList.contains('num')).toBe(false);
    expect(firstRow[1].classList.contains('num')).toBe(true);
  });
});
