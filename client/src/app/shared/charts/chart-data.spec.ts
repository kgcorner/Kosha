import {
  dayLabel,
  findPeriodTable,
  monthLabel,
  movingAverage,
  niceTicks,
  normalizePeriodTable,
  pledgeSeries,
  profileTiles,
  rangePosition,
  sortPeriods,
} from './chart-data';
import { columnPath } from './column-chart';

// Shapes copied from a real Tapetide response (City Union Bank, Oct 2026).
const SHAREHOLDING = {
  data: [
    {
      data: {
        FIIs: {
          'Dec 2025': 23.49,
          'Jun 2025': 27.38,
          'Sep 2026': 17.4,
          'Mar 2026': 23.37,
          'Jun 2026': 18.65,
        },
        DIIs: {
          'Dec 2025': 40.24,
          'Jun 2025': 35.23,
          'Sep 2026': 47.99,
          'Mar 2026': 40.74,
          'Jun 2026': 44.85,
        },
        Promoters: { 'Dec 2025': 0, 'Jun 2025': 0, 'Sep 2026': 0, 'Mar 2026': 0, 'Jun 2026': 0 },
      },
      period_type: 'quarterly',
      periods: ['Jun 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'],
      row_order: ['Promoters', 'FIIs', 'DIIs'],
    },
  ],
};
const FINANCIALS = {
  data: [
    {
      section: 'quarterly',
      data: {
        Revenue: { 'Jun 2026': 1985, 'Mar 2026': 1856 },
        'Net Profit': { 'Jun 2026': 383, 'Mar 2026': 360 },
      },
      periods: ['Mar 2026', 'Jun 2026'],
      row_order: ['Revenue', 'Net Profit'],
    },
    {
      section: 'profit_loss',
      data: { Revenue: { 'Mar 2026': 7000 } },
      periods: ['Mar 2026'],
      row_order: ['Revenue'],
    },
  ],
};

describe('chart data helpers', () => {
  it('sorts period labels chronologically with TTM last', () => {
    expect(sortPeriods(['Dec 2022', 'Jun 2021', 'TTM', 'Mar 2022'])).toEqual([
      'Jun 2021',
      'Mar 2022',
      'Dec 2022',
      'TTM',
    ]);
  });

  it('normalizes an unsorted shareholding table and trims to the latest periods', () => {
    const table = normalizePeriodTable(findPeriodTable(SHAREHOLDING), 3);
    expect(table?.periods).toEqual(['Mar 2026', 'Jun 2026', 'Sep 2026']);
    expect(table?.rows['FIIs']).toEqual([23.37, 18.65, 17.4]);
  });

  it('finds the quarterly table among financials sections', () => {
    const table = normalizePeriodTable(findPeriodTable(FINANCIALS, 'quarterly'));
    expect(table?.rows['Net Profit']).toEqual([360, 383]);
    expect(normalizePeriodTable(findPeriodTable(FINANCIALS, 'nope'))).toBeNull();
  });

  it('computes trailing moving averages with gaps until the window fills', () => {
    expect(movingAverage([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
  });

  it('builds ticks that cover the data range', () => {
    const ticks = niceTicks(0, 110);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(110);
  });

  it('reads pledge history (strings) oldest first', () => {
    const series = pledgeSeries({
      data: {
        quarterly_trend: [
          { quarter: '2026-09-30', pct_promoter_holding_pledged: '0' },
          { quarter: '2026-06-30', pct_promoter_holding_pledged: '1.5' },
        ],
      },
    });
    expect(series).toEqual({ periods: ['2026-06-30', '2026-09-30'], values: [1.5, 0] });
  });

  it('turns a profile payload into headline tiles and a 52-week range', () => {
    const profile = {
      data: {
        fundamentals: {
          stock_pe: 15.17,
          roe: 12.55,
          day_rsi14: 52.8,
          company_classification: 'Smallcap',
          high_52w: 248.85,
          low_52w: 168.75,
        },
        price_metrics: {
          price: 215.1,
          market_cap: 21311.83,
          pb: 2.02,
          pe_ttm: 15.17,
          high_52w: 248.85,
          low_52w: 168.75,
        },
        quote: { change_pct: 0.93 },
      },
    };
    const tiles = profileTiles(profile);
    expect(tiles.find((t) => t.label === 'Price')).toEqual({
      label: 'Price',
      value: '₹215.1',
      hint: '+0.93% today',
    });
    expect(tiles.find((t) => t.label === 'RSI (14d)')?.hint).toBe('Neutral');
    expect(tiles.some((t) => t.label === 'ROCE')).toBe(false);
    const range = rangePosition(profile);
    expect(Math.round(range?.pct ?? -1)).toBe(58);
  });

  it('draws columns rounded only at the data end', () => {
    expect(columnPath(10, 20, 100, 40)).toContain('Q10,40');
    expect(columnPath(10, 20, 100, 140)).toContain('V136');
  });

  it('formats ISO dates for axis ticks and tooltips', () => {
    expect(monthLabel('2026-06-29')).toBe('Jun 2026');
    expect(dayLabel('2026-06-29')).toBe('29 Jun 2026');
    expect(monthLabel('Jun 2026')).toBe('Jun 2026');
  });
});
