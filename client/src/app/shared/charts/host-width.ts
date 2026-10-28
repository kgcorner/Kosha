import { DestroyRef, ElementRef, Signal, afterNextRender, inject, signal } from '@angular/core';

/**
 * Tracks the host element's rendered width so a chart can use 1 SVG unit =
 * 1 CSS pixel. Text then stays at its real size on narrow screens instead of
 * shrinking with a scaled viewBox. Falls back to `fallback` where
 * ResizeObserver is unavailable (tests, SSR).
 */
export function hostWidth(fallback = 640, min = 280): Signal<number> {
  const host = inject(ElementRef<HTMLElement>);
  const width = signal(fallback);
  const destroyRef = inject(DestroyRef);
  afterNextRender(() => {
    const element = host.nativeElement as HTMLElement;
    const measure = () => {
      const w = Math.round(element.clientWidth);
      if (w > 0) width.set(Math.max(min, w));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    destroyRef.onDestroy(() => observer.disconnect());
  });
  return width.asReadonly();
}
