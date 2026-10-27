/**
 * Stock-like rows the Groww page parser mis-reads as stocks — section headings,
 * navigation labels and cash/repo instruments rather than real holdings. They are
 * excluded from every client list (leaderboard rows, sell-signal changes) so junk
 * never surfaces.
 *
 * Matching is case-insensitive and trims surrounding whitespace.
 */
export const EXCLUDED_STOCK_NAMES: readonly string[] = [
  'Net Payables',
  'Repo',
  'Reverse Repo',
  'TREPS',
  'Cash',
  'Cash & Cash Equivalents',
];

const EXCLUDED = new Set(EXCLUDED_STOCK_NAMES.map(normalizeName));

/** True when `name` is on the exclusion list and must not be rendered. */
export function isExcludedStockName(name: string): boolean {
  return EXCLUDED.has(normalizeName(name));
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}
