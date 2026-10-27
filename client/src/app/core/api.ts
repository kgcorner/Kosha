import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { CategoryChanges } from './models/category-changes';
import { Fund } from './models/fund';
import { LeaderboardRow } from './models/leaderboard-row';
import { ScrapeJob } from './models/scrape-job';

/** Base path for the backend API. Relative so the dev proxy / reverse proxy owns the host. */
export const API_BASE_PATH = '/api';

export const LEADERBOARD_LIMIT_MIN = 1;
export const LEADERBOARD_LIMIT_MAX = 100;
export const LEADERBOARD_OFFSET_MAX = 1_000_000;

export interface LeaderboardQuery {
  limit?: number;
  offset?: number;
  /** Fund category to scope the ranking to, e.g. `"Small Cap"`. Omit for all funds. */
  category?: string;
}

/**
 * Single HTTP gateway to the Stock Recommender backend. Every method returns a
 * cold `Observable<T>` and lets errors propagate (normalized by
 * `errorInterceptor`). Pagination values are clamped to the ranges the backend
 * accepts so a bad page state can never trigger a `400`.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly basePath = API_BASE_PATH;

  getLeaderboard(query: LeaderboardQuery = {}): Observable<LeaderboardRow[]> {
    let params = new HttpParams()
      .set('limit', String(clamp(query.limit ?? 20, LEADERBOARD_LIMIT_MIN, LEADERBOARD_LIMIT_MAX)))
      .set('offset', String(clamp(query.offset ?? 0, 0, LEADERBOARD_OFFSET_MAX)));
    if (query.category) {
      params = params.set('category', query.category);
    }
    return this.http.get<LeaderboardRow[]>(`${this.basePath}/stocks/leaderboard`, { params });
  }

  getFunds(): Observable<Fund[]> {
    return this.http.get<Fund[]>(`${this.basePath}/funds`);
  }

  /** Distinct fund categories, ordered — drives the leaderboard's category filter. */
  getCategories(): Observable<string[]> {
    return this.http.get<string[]>(`${this.basePath}/categories`);
  }

  /** List recent scrape jobs, newest first. `limit` is clamped to 1–100. */
  listJobs(limit = 20): Observable<ScrapeJob[]> {
    const params = new HttpParams().set(
      'limit',
      String(clamp(limit, LEADERBOARD_LIMIT_MIN, LEADERBOARD_LIMIT_MAX)),
    );
    return this.http.get<ScrapeJob[]>(`${this.basePath}/jobs`, { params });
  }

  getJob(id: number): Observable<ScrapeJob> {
    return this.http.get<ScrapeJob>(`${this.basePath}/jobs/${id}`);
  }

  /** Start a scrape. The backend replies `202` immediately with the job record. */
  startScrape(): Observable<ScrapeJob> {
    return this.http.post<ScrapeJob>(`${this.basePath}/jobs/scrape`, null);
  }

  getCategoryChanges(category: string): Observable<CategoryChanges> {
    return this.http.get<CategoryChanges>(
      `${this.basePath}/categories/${encodeURIComponent(category)}/changes`,
    );
  }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}
