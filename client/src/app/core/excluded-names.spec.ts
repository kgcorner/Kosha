import { EXCLUDED_STOCK_NAMES, isExcludedStockName } from './excluded-names';

describe('isExcludedStockName', () => {
  it('excludes the configured junk names', () => {
    expect(isExcludedStockName('Net Payables')).toBe(true);
    expect(isExcludedStockName('Repo')).toBe(true);
    expect(isExcludedStockName('Reverse Repo')).toBe(true);
    expect(isExcludedStockName('TREPS')).toBe(true);
    expect(isExcludedStockName('Cash & Cash Equivalents')).toBe(true);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(isExcludedStockName('  net payables ')).toBe(true);
    expect(isExcludedStockName('REPO')).toBe(true);
  });

  it('does not exclude real stocks', () => {
    expect(isExcludedStockName('Infosys')).toBe(false);
    expect(isExcludedStockName('HDFC Bank')).toBe(false);
  });

  it('does not exclude a name that merely contains a junk name', () => {
    expect(isExcludedStockName('Repo Industries')).toBe(false);
  });

  it('exposes the configured list', () => {
    expect(EXCLUDED_STOCK_NAMES).toEqual([
      'Net Payables',
      'Repo',
      'Reverse Repo',
      'TREPS',
      'Cash',
      'Cash & Cash Equivalents',
    ]);
  });
});
