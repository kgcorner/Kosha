/**
 * Canonical categories from the backend's `config/scraping.json`. Used only as
 * a fallback when `GET /api/funds` returns no funds yet — the primary source is
 * the distinct non-null `category` values discovered at runtime (§3.8).
 */
export const FALLBACK_CATEGORIES: readonly string[] = [
  'Mid Cap',
  'Large Cap',
  'Small Cap',
  'ELSS',
  'Thematic',
  'Value Oriented',
  'Flexi Cap',
];
