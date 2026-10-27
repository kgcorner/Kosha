import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';

/**
 * Normalized error surfaced to features. Carries the backend's `{ error }`
 * message verbatim (e.g. `409` "A scrape job is already running (job #N)")
 * so screens can render it as-is.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Functional interceptor that maps an `HttpErrorResponse` into an `ApiError`.
 *
 * It intentionally does **not** toast or log globally — the owning feature
 * decides how to present the failure. Non-JSON/unknown bodies fall back to a
 * readable status-based message so `[object Object]` never reaches the UI.
 */
export const errorInterceptor: HttpInterceptorFn = (request, next) =>
  next(request).pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse) {
        return throwError(() => new ApiError(error.status, extractMessage(error)));
      }
      return throwError(() => error);
    }),
  );

function extractMessage(error: HttpErrorResponse): string {
  const body: unknown = error.error;

  if (typeof body === 'string' && body.trim() !== '') {
    return body;
  }
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const message = (body as { error?: unknown }).error;
    if (typeof message === 'string' && message.trim() !== '') {
      return message;
    }
  }
  if (error.status === 0) {
    return 'Unable to reach the server. Is the backend running on port 3300?';
  }
  return `Request failed with status ${error.status}${error.statusText ? ` (${error.statusText})` : ''}.`;
}
