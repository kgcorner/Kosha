import { Component, computed, input, signal } from '@angular/core';

import { compact, niceTicks } from './chart-data';
import { hostWidth } from './host-width';

export interface LineSeries {
  name: string;
  /** Aligned to the chart's `labels`; null = gap. */
  values: Array<number | null>;
  /** Categorical slot 1–4 (fixed order, never cycled). */
  slot: 1 | 2 | 3 | 4;
}

const PAD = { top: 12, right: 16, bottom: 26, left: 48 };

/**
 * Minimal SVG line chart: one y-axis, 2px lines, recessive gridlines, end
 * dots with a surface ring, a legend for ≥2 series, and a crosshair tooltip
 * listing every series at the hovered/focused x (arrow keys move it).
 */
@Component({
  selector: 'app-line-chart',
  templateUrl: './line-chart.html',
  styleUrl: './charts.scss',
})
export class LineChart {
  readonly labels = input.required<string[]>();
  readonly series = input.required<LineSeries[]>();
  readonly caption = input('');
  readonly height = input(220);
  /** Start the y-axis at zero (percentages, counts). */
  readonly zeroBased = input(false);
  readonly format = input<(value: number) => string>((value) => compact(value));
  /** Formats x-axis tick labels (e.g. ISO date → "Oct 2025"). */
  readonly xTick = input<(label: string) => string>((label) => label);
  /** Formats the tooltip title (e.g. ISO date → "29 Jun 2026"). */
  readonly xTitle = input<(label: string) => string>((label) => label);

  /** Rendered width in px; the viewBox matches it so text never scales. */
  protected readonly widthPx = hostWidth();
  protected readonly pad = PAD;
  protected readonly active = signal<number | null>(null);

  private readonly values = computed(() =>
    this.series()
      .flatMap((s) => s.values)
      .filter((v): v is number => v !== null && Number.isFinite(v)),
  );

  protected readonly ticks = computed(() => {
    const values = this.values();
    if (values.length === 0) return [0, 1];
    const min = this.zeroBased() ? Math.min(0, ...values) : Math.min(...values);
    return niceTicks(min, Math.max(...values));
  });

  private readonly plot = computed(() => ({
    x0: PAD.left,
    x1: this.widthPx() - PAD.right,
    y0: PAD.top,
    y1: this.height() - PAD.bottom,
  }));

  protected x(index: number): number {
    const { x0, x1 } = this.plot();
    const n = this.labels().length;
    return n <= 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * index) / (n - 1);
  }

  protected y(value: number): number {
    const ticks = this.ticks();
    const lo = ticks[0];
    const hi = ticks[ticks.length - 1];
    const { y0, y1 } = this.plot();
    return hi === lo ? (y0 + y1) / 2 : y1 - ((value - lo) / (hi - lo)) * (y1 - y0);
  }

  protected readonly paths = computed(() =>
    this.series().map((s) => {
      let d = '';
      let pen = false;
      s.values.forEach((value, index) => {
        if (value === null || !Number.isFinite(value)) {
          pen = false;
          return;
        }
        d += `${pen ? 'L' : 'M'}${this.x(index).toFixed(1)},${this.y(value).toFixed(1)}`;
        pen = true;
      });
      return { slot: s.slot, name: s.name, d };
    }),
  );

  /** Last non-null point of each series, for the end dot. */
  protected readonly ends = computed(() =>
    this.series()
      .map((s) => {
        for (let i = s.values.length - 1; i >= 0; i -= 1) {
          const v = s.values[i];
          if (v !== null && Number.isFinite(v))
            return { slot: s.slot, cx: this.x(i), cy: this.y(v) };
        }
        return null;
      })
      .filter((end): end is { slot: 1 | 2 | 3 | 4; cx: number; cy: number } => end !== null),
  );

  /** ≤6 evenly spaced x labels (always first and last). */
  protected readonly xTicks = computed(() => {
    const n = this.labels().length;
    if (n === 0) return [];
    // About one label per 110px, at most 6, always first and last.
    const count = Math.max(2, Math.min(6, n, Math.floor(this.widthPx() / 110)));
    const picks = new Set<number>();
    for (let i = 0; i < count; i += 1)
      picks.add(Math.round(((n - 1) * i) / Math.max(1, count - 1)));
    return [...picks].map((index) => ({ index, label: this.xTick()(this.labels()[index]) }));
  });

  protected readonly readout = computed(() => {
    const index = this.active();
    if (index === null) return null;
    return {
      index,
      label: this.xTitle()(this.labels()[index]),
      x: this.x(index),
      // Series without a value here (e.g. a 200-day average before 200 days) are omitted.
      rows: this.series()
        .filter((s) => s.values[index] !== null && s.values[index] !== undefined)
        .map((s) => ({
          name: s.name,
          slot: s.slot,
          value: s.values[index],
          cy: this.y(s.values[index] as number),
        })),
    };
  });

  protected readonly summary = computed(() => {
    const parts = this.series().map((s) => {
      const last = [...s.values].reverse().find((v) => v !== null);
      return last === undefined || last === null
        ? s.name
        : `${s.name} latest ${this.format()(last)}`;
    });
    return `${this.caption()}. ${parts.join('; ')}.`;
  });

  protected onPointer(event: PointerEvent, svg: Element): void {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const px = ((event.clientX - rect.left) / rect.width) * this.widthPx();
    const n = this.labels().length;
    const { x0, x1 } = this.plot();
    const index = n <= 1 ? 0 : Math.round(((px - x0) / (x1 - x0)) * (n - 1));
    this.active.set(Math.min(n - 1, Math.max(0, index)));
  }

  protected onKey(event: KeyboardEvent): void {
    const n = this.labels().length;
    if (n === 0) return;
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
