import { TestBed } from '@angular/core/testing';

import { ColumnChart } from './column-chart';
import { LineChart } from './line-chart';

describe('LineChart', () => {
  afterEach(() => TestBed.resetTestingModule());

  function render(
    series: Array<{ name: string; values: Array<number | null>; slot: 1 | 2 | 3 | 4 }>,
  ) {
    const fixture = TestBed.createComponent(LineChart);
    fixture.componentRef.setInput('labels', ['Jun 2026', 'Jul 2026', 'Aug 2026']);
    fixture.componentRef.setInput('series', series);
    fixture.componentRef.setInput('caption', 'Test chart');
    fixture.detectChanges();
    return fixture;
  }

  it('draws one path per series, a legend for 2+ series, and an accessible summary', () => {
    const fixture = render([
      { name: 'FIIs', values: [27, 23, 17], slot: 2 },
      { name: 'DIIs', values: [35, null, 48], slot: 3 },
    ]);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('path.line').length).toBe(2);
    expect(el.querySelectorAll('.chart__legend li').length).toBe(2);
    expect(el.querySelector('svg')?.getAttribute('aria-label')).toContain('FIIs latest 17');
    // The null breaks the DIIs line into two pens (two "M" commands).
    const diis = el.querySelectorAll('path.line')[1].getAttribute('d') ?? '';
    expect(diis.match(/M/g)?.length).toBe(2);
  });

  it('shows no legend for a single series and a tooltip on keyboard focus', () => {
    const fixture = render([{ name: 'Close', values: [100, 110, 105], slot: 1 }]);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.chart__legend')).toBeNull();
    el.querySelector('svg')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    fixture.detectChanges();
    expect(el.querySelector('.tooltip')?.textContent).toContain('Jul 2026');
    expect(el.querySelector('.tooltip')?.textContent).toContain('110');
  });

  it('omits series without a value at the hovered point', () => {
    const fixture = render([
      { name: 'Close', values: [100, 110, 105], slot: 1 },
      { name: '200-day avg', values: [null, null, 104], slot: 3 },
    ]);
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector('svg')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    fixture.detectChanges();
    expect(el.querySelectorAll('.tooltip__row').length).toBe(1);
  });
});

describe('ColumnChart', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('draws a column per non-empty value and a tooltip per period', () => {
    const fixture = TestBed.createComponent(ColumnChart);
    fixture.componentRef.setInput('labels', ['Mar 2026', 'Jun 2026']);
    fixture.componentRef.setInput('series', [
      { name: 'Revenue', values: [1856, 1985], slot: 1 },
      { name: 'Net profit', values: [360, null], slot: 2 },
    ]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('path.column').length).toBe(3);
    el.querySelectorAll('rect.hit')[1].dispatchEvent(new Event('pointerenter'));
    fixture.detectChanges();
    const tooltip = el.querySelector('.tooltip')?.textContent ?? '';
    expect(tooltip).toContain('Jun 2026');
    expect(tooltip).toContain('2K');
    expect(tooltip).toContain('—');
  });
});
