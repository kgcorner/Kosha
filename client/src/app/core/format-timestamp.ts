const EMPTY_PLACEHOLDER = '—';

/** Matches the backend's `"YYYY-MM-DD HH:MM:SS"` (no timezone, not ISO 8601). */
const BACKEND_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

export interface FormatTimestampOptions {
  /** BCP-47 locale passed to `Intl.DateTimeFormat`. Defaults to `en-IN`. */
  locale?: string;
  /** When `true` (default) the date *and* time are rendered; otherwise date only. */
  withTime?: boolean;
}

/**
 * Formats a backend timestamp (`"YYYY-MM-DD HH:MM:SS"`) for display.
 *
 * The backend emits local-time strings without a zone; `new Date('2026-10-15 06:12:44')`
 * is implementation-dependent (Safari may return `Invalid Date`), so the string is
 * parsed via explicit date parts and treated as **local time**.
 *
 * - `null`/empty → `'—'`.
 * - unparseable → the raw string (never throws).
 */
export function formatTimestamp(
  value: string | null | undefined,
  options: FormatTimestampOptions = {},
): string {
  if (value === null || value === undefined || value.trim() === '') {
    return EMPTY_PLACEHOLDER;
  }

  const parsed = parseBackendTimestamp(value);
  if (!parsed) {
    return value;
  }

  const formatter = new Intl.DateTimeFormat(options.locale ?? 'en-IN', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    ...(options.withTime === false ? {} : { hour: '2-digit', minute: '2-digit', hour12: true }),
  });
  return formatter.format(parsed);
}

/**
 * True when `value` is a valid backend timestamp. Used to flag "stale"/"unknown"
 * cells without rendering an `Invalid Date`.
 */
export function isParseableTimestamp(value: string | null | undefined): boolean {
  return parseBackendTimestamp(value ?? null) !== null;
}

/**
 * Parses a backend `"YYYY-MM-DD HH:MM:SS"` string as **local time** into a `Date`.
 * Returns `null` for `null`/empty/malformed input (never throws).
 */
export function parseBackendTimestamp(value: string | null): Date | null {
  if (value === null) {
    return null;
  }
  const match = BACKEND_TIMESTAMP.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}
