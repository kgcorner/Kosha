import { Injectable, signal } from '@angular/core';

/**
 * Broadcasts an explicit "data changed, reload" request across feature screens
 * (e.g. after a scrape job completes). Features watch `token` with an `effect`
 * and refetch their own read endpoints — there is no websocket/SSE (§7.5).
 */
@Injectable({ providedIn: 'root' })
export class DataRefreshService {
  private readonly tokenState = signal(0);

  /** Monotonically increasing token; changes whenever a reload is requested. */
  readonly token = this.tokenState.asReadonly();

  requestRefresh(): void {
    this.tokenState.update((value) => value + 1);
  }
}
