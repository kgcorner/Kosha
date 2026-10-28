import { formatDuration, formatElapsedSince } from './format-duration';

describe('formatDuration', () => {
  it('renders seconds only below a minute', () => {
    expect(formatDuration(12)).toBe('12s');
  });

  it('renders minutes and zero-padded seconds below an hour', () => {
    expect(formatDuration(125)).toBe('2m 05s');
  });

  it('renders hours and zero-padded minutes at or above an hour', () => {
    expect(formatDuration(3720)).toBe('1h 02m');
  });

  it('clamps negative input to zero', () => {
    expect(formatDuration(-5)).toBe('0s');
  });

  it('floors fractional seconds', () => {
    expect(formatDuration(59.9)).toBe('59s');
  });
});

describe('formatElapsedSince', () => {
  it('returns an em dash for null input', () => {
    expect(formatElapsedSince(null)).toBe('—');
  });

  it('returns an em dash for a malformed timestamp', () => {
    expect(formatElapsedSince('nope')).toBe('—');
  });

  it('computes the elapsed span between two timestamps', () => {
    const to = new Date(Date.UTC(2026, 9, 15, 6, 2, 5));
    expect(formatElapsedSince('2026-10-15 06:00:00', to)).toBe('2m 05s');
  });

  it('never returns a negative duration when the end is before the start', () => {
    const to = new Date(Date.UTC(2026, 9, 15, 5, 0, 0));
    expect(formatElapsedSince('2026-10-15 06:00:00', to)).toBe('0s');
  });
});
