import { Component, computed, input } from '@angular/core';

/** Deepest level rendered as structure; anything below is shown as compact JSON. */
export const DATA_VIEW_MAX_DEPTH = 4;
/** Columns shown for an array of records (extra keys are dropped from the table). */
export const DATA_VIEW_MAX_COLUMNS = 12;
/** Rows shown for an array before a "+N more" note. */
export const DATA_VIEW_MAX_ROWS = 40;

type Kind = 'empty' | 'scalar' | 'list' | 'table' | 'object' | 'json';

interface Entry {
  key: string;
  value: unknown;
}

/**
 * Renders arbitrary JSON from a data provider readably, without knowing its
 * shape in advance: scalars as text, arrays of scalars as a list, arrays of
 * records as a table, objects as a label/value list (recursively). Used for
 * fundamentals, whose payload is defined by the provider and may change.
 */
@Component({
  selector: 'app-data-view',
  templateUrl: './data-view.html',
  styleUrl: './data-view.scss',
})
export class DataView {
  readonly value = input<unknown>(null);
  readonly depth = input(0);

  protected readonly kind = computed<Kind>(() => kindOf(this.value(), this.depth()));

  protected readonly entries = computed<Entry[]>(() => {
    const value = this.value();
    if (!isRecord(value)) {
      return [];
    }
    return Object.entries(value)
      .filter(([, entry]) => !isBlank(entry))
      .map(([key, entry]) => ({ key, value: entry }));
  });

  protected readonly rows = computed<Record<string, unknown>[]>(() => {
    const value = this.value();
    return Array.isArray(value) ? value.slice(0, DATA_VIEW_MAX_ROWS).filter(isRecord) : [];
  });

  protected readonly columns = computed<string[]>(() => {
    const keys: string[] = [];
    for (const row of this.rows()) {
      for (const [key, entry] of Object.entries(row)) {
        if (!keys.includes(key) && !isBlank(entry)) {
          keys.push(key);
        }
      }
    }
    return keys.slice(0, DATA_VIEW_MAX_COLUMNS);
  });

  protected readonly items = computed<unknown[]>(() => {
    const value = this.value();
    return Array.isArray(value)
      ? value.slice(0, DATA_VIEW_MAX_ROWS).filter((item) => !isBlank(item))
      : [];
  });

  protected readonly hiddenCount = computed(() => {
    const value = this.value();
    return Array.isArray(value) ? Math.max(0, value.length - DATA_VIEW_MAX_ROWS) : 0;
  });

  protected readonly json = computed(() => compactJson(this.value()));

  protected label(key: string): string {
    return humanizeKey(key);
  }

  protected scalar(value: unknown): string {
    return formatScalar(value);
  }

  protected isNumber(value: unknown): boolean {
    return typeof value === 'number';
  }

  protected isNested(value: unknown): boolean {
    return typeof value === 'object' && value !== null;
  }

  protected cell(value: unknown): string {
    return this.isNested(value) ? compactJson(value, 80) : formatScalar(value);
  }
}

export function kindOf(value: unknown, depth = 0): Kind {
  if (isBlank(value)) {
    return 'empty';
  }
  if (typeof value !== 'object') {
    return 'scalar';
  }
  if (depth > DATA_VIEW_MAX_DEPTH) {
    return 'json';
  }
  if (Array.isArray(value)) {
    const present = value.filter((item) => !isBlank(item));
    if (present.length > 0 && present.every(isRecord)) {
      return 'table';
    }
    return present.some((item) => typeof item === 'object') ? 'json' : 'list';
  }
  return Object.values(value as Record<string, unknown>).every(isBlank) ? 'empty' : 'object';
}

/** `debt_to_equity` / `debtToEquity` → `Debt to equity`; acronyms like PE/ROE stay upper-case. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .split(/\s+/);
  const acronyms = new Set([
    'pe',
    'pb',
    'eps',
    'roe',
    'roce',
    'roa',
    'ttm',
    'ebitda',
    'nse',
    'bse',
    'isin',
    'fii',
    'dii',
    'yoy',
    'qoq',
    'ev',
    'cagr',
    'opm',
    'npm',
    'nav',
    'ltp',
    'sma',
    'ema',
    'rsi',
  ]);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (acronyms.has(lower)) {
        return lower.toUpperCase();
      }
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

/** Numbers use Indian digit grouping with at most 2 decimals. */
export function formatScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? value.toLocaleString('en-IN', { maximumFractionDigits: 2 })
      : '—';
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  return String(value);
}

function compactJson(value: unknown, max = 400): string {
  const text = JSON.stringify(value) ?? '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlank(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}
