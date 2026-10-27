import { parseBackendTimestamp } from './format-timestamp';

/**
 * Formats the elapsed time between a backend timestamp and now (or a second
 * timestamp) as a compact `"2m 05s"` string. Returns `'—'` when `from` is
 * `null`/malformed.
 */
export function formatElapsedSince(from: string | null, to: Date = new Date()): string {
  const start = parseBackendTimestamp(from);
  if (start === null) {
    return '—';
  }
  const seconds = Math.max(0, Math.round((to.getTime() - start.getTime()) / 1000));
  return formatDuration(seconds);
}

/** Formats a whole number of seconds as `"1h 02m"`, `"2m 05s"` or `"12s"`. */
export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;

  if (hours > 0) {
    return `${hours}h ${pad(minutes)}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${pad(secs)}s`;
  }
  return `${secs}s`;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}
