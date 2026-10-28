/**
 * A tracked mutual fund returned by `GET /api/funds`, ordered by `name`.
 */
export interface Fund {
  id: number;
  name: string;
  url: string;
  category: string | null;
  /** Backend UTC timestamp `"YYYY-MM-DD HH:MM:SS"`; `null` before the first scrape. */
  last_scraped_at: string | null;
}
