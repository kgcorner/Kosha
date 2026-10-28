import { formatTimestamp, isParseableTimestamp, parseBackendTimestamp } from './format-timestamp';

describe('formatTimestamp', () => {
  it('returns an em dash for null', () => {
    expect(formatTimestamp(null)).toBe('—');
  });

  it('returns an em dash for an empty string', () => {
    expect(formatTimestamp('   ')).toBe('—');
  });

  it('formats a valid backend timestamp without producing Invalid Date', () => {
    const formatted = formatTimestamp('2026-10-15 06:12:44');
    expect(formatted).not.toBe('Invalid Date');
    expect(formatted).not.toBe('—');
    expect(formatted).toContain('2026');
  });

  it('treats the timestamp as UTC (SQLite CURRENT_TIMESTAMP)', () => {
    const parsed = parseBackendTimestamp('2026-10-15 06:12:44');
    expect(parsed).not.toBeNull();
    expect(parsed?.getUTCFullYear()).toBe(2026);
    expect(parsed?.getUTCMonth()).toBe(9);
    expect(parsed?.getUTCDate()).toBe(15);
    expect(parsed?.getUTCHours()).toBe(6);
    expect(parsed?.getUTCMinutes()).toBe(12);
    expect(parsed?.getUTCSeconds()).toBe(44);
  });

  it('accepts an ISO-style T separator', () => {
    expect(isParseableTimestamp('2026-10-15T06:12:44')).toBe(true);
  });

  it('returns the raw string for a malformed value rather than throwing', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });

  it('returns the raw string for a partially malformed value', () => {
    expect(formatTimestamp('2026/10/15 06:12:44')).toBe('2026/10/15 06:12:44');
  });

  it('does not throw for an out-of-range numeric value', () => {
    expect(() => formatTimestamp('2026-13-45 99:99:99')).not.toThrow();
  });

  it('parses null to null', () => {
    expect(parseBackendTimestamp(null)).toBeNull();
  });
});
