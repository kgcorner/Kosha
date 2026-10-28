import { Component, computed, input, signal } from '@angular/core';

import { compact, niceTicks } from './chart-data';
import { hostWidth } from './host-width';

export interface ColumnSeries {
  name: string;
  values: Array<number | null>;
  slot: 1 | 2 | 3 | 4;
}

const PAD = { top: 12, right: 12, bottom: 26, left: 48 };
const MAX_BAR = 24;
const GAP = 2;

/**
 * Grouped column chart: one zero baseline, columns ≤24px with a 4px rounded
 * data end (square at the baseline), a 2px surface gap between columns of a
 * group, a legend for ≥2 series and a per-period hover/focus tooltip.
 */
@Component({
  selector: 'app-column-chart',
  templateUrl: './column-chart.html',
  styleUrl: './charts.scss',
})
export class ColumnChart {
  readonly labels = input.required<string[]>();
  readonly series = input.required<ColumnSeries[]>();
  readonly caption = input('');
  readonly height = input(220);
  readonly format = input<(value: number) => string>((value) => compact(value));

  /** Rendered width in px; the viewBox matches it so text never scales. */
  protected readonly widthPx = hostWidth();
  protected readonly pad = PAD;
  protected readonly active = signal<number | null>(null);

  protected readonly ticks = computed(() => {
    const values = this.series()
      .flatMap((s) => s.values)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    if (values.length === 0) return [0, 1];
    return niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  });

  protected y(value: number): number {
    const ticks = this.ticks();
    const lo = ticks[0];
    const hi = ticks[ticks.length - 1];
    const y0 = PAD.top;
    const y1 = this.height() - PAD.bottom;
    return hi === lo ? y1 : y1 - ((value - lo) / (hi - lo)) * (y1 - y0);
  }

  private band(): number {
    return (this.widthPx() - PAD.left - PAD.right) / Math.max(1, this.labels().length);
  }

  protected center(index: number): number {
    return PAD.left + this.band() * (index + 0.5);
  }

  protected readonly bars = computed(() => {
    const n = this.series().length;
    const band = this.band();
    const barWidth = Math.max(4, Math.min(MAX_BAR, (band * 0.7 - GAP * (n - 1)) / n));
    const group = barWidth * n + GAP * (n - 1);
    const zero = this.y(0);
    const bars: Array<{ key: string; slot: number; d: string }> = [];
    this.labels().forEach((_, index) => {
      const left = this.center(index) - group / 2;
      this.series().forEach((s, si) => {
        const value = s.values[index];
        if (value === null || !Number.isFinite(value) || value === 0) return;
        const x = left + si * (barWidth + GAP);
        bars.push({
          key: `${index}-${si}`,
          slot: s.slot,
          d: columnPath(x, barWidth, zero, this.y(value)),
        });
      });
    });
    return bars;
  });

  protected readonly readout = computed(() => {
    const index = this.active();
    if (index === null) return null;
    return {
      x: this.center(index),
      label: this.labels()[index],
      rows: this.series().map((s) => ({ name: s.name, slot: s.slot, value: s.values[index] })),
    };
  });

  protected readonly summary = computed(() => {
    const last = this.labels().length - 1;
    const parts = this.series().map((s) => `${s.name} ${this.display(s.values[last] ?? null)}`);
    return `${this.caption()}. Latest (${this.labels()[last] ?? ''}): ${parts.join(', ')}.`;
  });

  /** Show every period label only when there is room (~64px each). */
  protected showLabel(index: number): boolean {
    const n = this.labels().length;
    const room = Math.max(1, Math.floor((this.widthPx() - PAD.left - PAD.right) / 64));
    if (n <= room) return true;
    const step = Math.ceil(n / room);
    return index === n - 1 || (n - 1 - index) % step === 0;
  }

  protected bandLeft(index: number): number {
    return PAD.left + this.band() * index;
  }

  protected bandWidth(): number {
    return this.band();
  }

  protected onKey(event: KeyboardEvent): void {
    const n = this.labels().length;
    const current = this.active() ?? n - 1;
    if (event.key === 'ArrowLeft') {
      this.active.set(Math.max(0, current - 1));
      event.preventDefault();
    } else if (event.key === 'ArrowRight') {
      this.active.set(Math.min(n - 1, current + 1));
      event.preventDefault();
    } else if (event.key === 'Escape') {
      this.active.set(null);
    }
  }

  protected tooltipLeft(x: number): string {
    return `${(x / this.widthPx()) * 100}%`;
  }

  protected display(value: number | null): string {
    return value === null || value === undefined ? '—' : this.format()(value);
  }
}

/** Column from the baseline to the value, rounded (r=4) only at the data end. */
export function columnPath(x: number, width: number, base: number, top: number): string {
  const r = Math.min(4, width / 2, Math.abs(base - top));
  if (top <= base) {
    // Positive: grows up, rounded top.
    return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${base}Z`;
  }
  // Negative: grows down, rounded bottom.
  return `M${x},${base}V${top - r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top - r}V${base}Z`;
}
