# Angular Client Requirements Document: Kosha (Stock Recommender UI)

Requirements for the Angular front end (`kosha/`) that consumes the **Stock Recommender backend REST API** described in [`backend/docs/FEATURES.md`](../../backend/docs/FEATURES.md).

This document is the client-side counterpart to the backend's `FEATURES.md`. It defines *what the Angular client must do*, *how it integrates with the API*, and *how it will be verified*. It does **not** restate backend internals except where they constrain the UI (e.g. weights are always `0`, AI fields may be `null`).

---

## 1. Executive Summary

The client is a **read-mostly, single-page Angular application** that presents:

1. **Consensus leaderboard** — stocks held by the most mutual funds, ranked, optionally with AI thesis / pros / cons.
2. **Sell signals** — stocks *removed* from a followed category since the last detection run, surfaced as actionable alerts.
3. **Tracked funds** — the mutual funds being scraped and when each was last refreshed.
4. **Scrape control & monitoring** — a button to trigger the full pipeline and live progress polling of the asynchronous job.

The backend computes everything; the client is a thin, resilient presentation layer. All data endpoints always serve the **latest persisted state**, so the UI remains useful even while a scrape is running.

### 1.1 Goals

- Show the ranked consensus list with score, rank, and AI enrichment when available.
- Turn category **`removed`** events into clear sell-signal alerts.
- Let a user trigger a scrape and watch it progress without blocking.
- Degrade gracefully: partial data, absent AI, empty history, and API errors must all render sensibly.

### 1.2 Non-Goals (Out of Scope)

- No authentication/authorization (backend exposes no auth; assumed local/trusted use).
- No trading, order placement, or brokerage integration.
- No editing of funds, categories, XPath selectors, or scrape configuration.
- No backtesting or price-history charting. The backend serves a **single snapshot** of per-stock metrics (price + fundamentals), not a time series, so the client displays the latest values only.
- No server-side rendering requirement (SPA only).

---

## 2. Tech Stack & Conventions

Aligned with the existing `kosha/` workspace — **use only what is already installed**.

| Concern | Choice | Notes |
|---|---|---|
| Framework | **Angular 22** (`^22.0.0`) | Standalone components only (no `NgModule`s). |
| Language | **TypeScript ~6.0.2** | `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noImplicitReturns`, `noFallthroughCasesInSwitch` are enforced. |
| Reactivity | **Angular signals** (`signal`, `computed`, `effect`) | Prefer signals over manual `BehaviorSubject` state. |
| Async data | **RxJS 7.8** + `HttpClient` | Register `provideHttpClient(withFetch())`. |
| Templates | **New control flow** (`@if`, `@for`, `@switch`) | Do not use `*ngIf`/`*ngFor`. |
| Styling | **SCSS**, component-scoped `styleUrl` | Global theme tokens in `src/styles.scss`. |
| Routing | `@angular/router` | Already wired via `provideRouter(routes)`. |
| Tests | **Vitest 4** (`ng test`), jsdom | Component + service unit tests. |
| Formatting | **Prettier 3** | Match existing `.prettierrc`. |
| Build | `ng build` / `ng serve` | `@angular/build:application`. |

### 2.1 Additional Dependencies

**None required.** Do not add a state library (NgRx), a UI kit (Material), or `ngx-*` packages unless a future ADR approves it. All UI is hand-built with SCSS.

### 2.2 File & Naming Conventions (from the scaffold)

- Components: `feature-name.ts` (`@Component`), `feature-name.html`, `feature-name.scss`, `feature-name.spec.ts`.
- Class names: `App`, `Leaderboard`, `SellSignals` (no `Component` suffix — matches scaffold `App`).
- Selectors: prefix `app` (e.g. `app-leaderboard`).
- Services under `src/app/core/`, models under `src/app/core/models/`.
- Use `protected` for template-exposed members (matches scaffold `App`).

---

## 3. Backend Integration Contract

**Base URL:** `http://localhost:5100` (backend default port; see `config/app.json`). Every response is JSON; every error is `{ "error": "<message>" }`.

### 3.1 CORS / Dev Proxy — REQUIRED SETUP

The backend (`backend/src/app.js`) currently registers **no CORS middleware**. Therefore the client MUST NOT rely on cross-origin browser requests. Two acceptable options, in order of preference:

1. **Add an Angular dev-server proxy** (`kosha/proxy.conf.json`) mapping `/api` → `http://localhost:5100`, and run `ng serve --proxy-config proxy.conf.json` (add `serve.options.proxyConfig` in `angular.json`). The client then calls **relative** URLs (`/api/...`), which also works behind a reverse proxy in production.
2. If a proxy is not used, the backend must add CORS middleware. **This is a backend change, out of scope for the client ticket** — raise it separately.

**Requirement:** `ApiService` MUST use a configurable relative base path (`/api`). Do not hard-code `http://localhost:5100` into components.

### 3.2 Endpoint: `GET /api/stocks/leaderboard`

Primary read model.

- Query params: `limit` (int, default `20`, **1–100**), `offset` (int, default `0`, **0–1000000**), `category` (string, optional — scope the ranking to funds of that category, URL-encoded).
- Returns an **array** (not an envelope):

```ts
interface LeaderboardRow {
  stock_id: number;
  name: string;
  consensus_score: number;         // number of distinct funds holding the stock
  total_weight_sum: number;        // raw sum of Assets % across funds — internal ordering only, NOT displayed
  weight_avg: number | null;       // average Assets % a single holding fund allocates; null when none publish a weight
  weight_min: number | null;       // lowest per-fund Assets %
  weight_max: number | null;       // highest per-fund Assets %
  rank: number;                    // 1-based; recomputed within `category` when filtered
  stock_url: string | null;        // the stock's own Groww detail page (metrics were scraped from it)
  metrics: StockMetrics | null;    // scraped price + fundamentals; null until the stock page is visited
  categories: string[];            // every category holding the stock, e.g. ["Large Cap","Flexi Cap"]
  thesis: string | null;           // null until AI enrichment runs
  pros: string[];                  // [] until AI enrichment runs
  cons: string[];                  // [] until AI enrichment runs
  last_analyzed_at: string | null; // "YYYY-MM-DD HH:MM:SS" (backend-local, not ISO)
}

// Group/field keys mirror config/scraping.json → selectors.stock_page.metrics,
// so treat this as configuration-driven: a scalar is a string (original
// formatting, e.g. "₹11,23,322Cr"); trend metrics are string arrays; some
// metrics (e.g. 52-week range) are small objects.
interface StockMetrics {
  core_identifiers_and_market_metrics?: Record<string, MetricValue>;
  valuation_and_fundamental_ratios?: Record<string, MetricValue>;
  financial_performance_trends?: Record<string, MetricValue>;
  shareholding_pattern?: Record<string, MetricValue>;
  corporate_actions_and_events?: Record<string, MetricValue>;
  recent_news_and_regulatory_filings?: Record<string, MetricValue>;
  peer_comparison_benchmarks?: Record<string, MetricValue>;
  [group: string]: Record<string, MetricValue> | undefined;
}
type MetricValue = string | string[] | Record<string, unknown> | null;
```

- When `category` is supplied, `consensus_score` counts only that category's funds and `rank` is recomputed within the category.
- Errors: `400` for non-numeric or out-of-range `limit`/`offset`.
- **Client must clamp** `limit` to 1–100 and `offset` to ≥ 0 before sending, and surface a friendly message for any `400`.

### 3.3 Endpoint: `GET /api/funds`

- No params. Returns an array ordered by `name`:

```ts
interface Fund {
  id: number;
  name: string;
  url: string;
  category: string | null;
  last_scraped_at: string | null; // "YYYY-MM-DD HH:MM:SS"
}
```

### 3.4 Endpoint: `GET /api/stocks/:id/metrics`

- Path param `id`: the `stock_id` from the leaderboard.
- Returns the full metric set scraped from that stock's Groww detail page (already embedded on the leaderboard row as `metrics`, so use this endpoint only for a focused per-stock view):

```ts
interface StockMetricsResponse {
  stock_id: number;
  name: string;
  stock_url: string | null;
  page_title: string | null;
  metrics: StockMetrics | null;               // see §3.2
  provenance: Record<string, string> | null;  // per-metric: "xpath" | "hint" | "label" | "payload" | "none"
  updated_at: string | null;
}
```

- `404` for an unknown `stock_id`.
- Metrics are scraped from the stock's *own* page (not the fund's holdings table), so they are `null` until a scrape has visited that stock.

### 3.5 Endpoint: `POST /api/jobs/scrape`

- No body. **Returns `202` immediately** with a job record (work continues in background).
- Errors: `409` when a job is already queued/running: `{ "error": "A scrape job is already running (job #N)" }`.

```ts
interface ScrapeJob {
  id: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  stage: 'discovering_funds' | 'scraping_holdings' | 'aggregating'
       | 'detecting_changes' | 'completed' | 'failed' | null;
  funds_found: number | null;
  stocks: number | null;
  result: {
    funds: number;
    stocks: number;
    stock_metrics?: number; // stock pages whose metrics were captured this run
    changes: { added: number; removed: number };
  } | null;
  error: string | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}
```

### 3.6 Endpoint: `GET /api/jobs/:id`

- Poll a job. Returns the same `ScrapeJob` shape.
- Errors: `404 { "error": "Scrape job #<id> not found" }` for unknown/non-numeric ids.

### 3.7 Endpoint: `GET /api/jobs?limit=20`

- List recent jobs, **newest first**. `limit` int, default `20`, **1–100**. Returns an array of `ScrapeJob`.

### 3.8 Endpoint: `GET /api/categories/:category/changes`

- `category` is **case-sensitive** and URL-encoded (e.g. `Flexi%20Cap`). The client MUST `encodeURIComponent` when building the URL.
- Returns the latest change run for the category:

```ts
interface CategoryChanges {
  category: string;
  run_id: number | null;
  run_at: string | null;         // "YYYY-MM-DD HH:MM:SS"
  removed: { stock_id: number; name: string }[]; // SELL SIGNAL
  added:   { stock_id: number; name: string }[];
}
```

- **Important:** an unknown category is **not** a `404` — it returns the empty shape (`run_id: null`, `run_at: null`, `removed: []`, `added: []`). The client MUST treat empty lists as "no signal", not as an error.

### 3.9 Known Categories

The backend exposes no "list categories" endpoint. The canonical set (from `config/scraping.json`) is:

> Mid Cap, Large Cap, Small Cap, ELSS, Thematic, Value Oriented, Flexi Cap

**Requirement:** the client derives the category list at runtime from the distinct non-null `category` values in `GET /api/funds`, and MAY fall back to the static seven when `/api/funds` is empty/unavailable. This keeps the UI correct if backend categories change.

---

## 4. Domain Models (TypeScript)

Place in `src/app/core/models/`. All fields mirror the API exactly (snake_case) to avoid a mapping layer; add a **view model** only where the UI needs derived values.

```ts
// models/leaderboard-row.ts
export interface LeaderboardRow { /* see §3.2 */ }

// models/stock-metrics.ts
export interface StockMetrics { /* see §3.2 */ }
export type MetricValue = string | string[] | Record<string, unknown> | null;

// models/fund.ts
export interface Fund { /* see §3.3 */ }

// models/scrape-job.ts
export type ScrapeStatus = 'queued' | 'running' | 'completed' | 'failed';
export type ScrapeStage =
  | 'discovering_funds' | 'scraping_holdings' | 'aggregating'
  | 'detecting_changes' | 'completed' | 'failed';
export interface ScrapeJob { /* see §3.5 */ }

// models/category-changes.ts
export interface CategoryChange { stock_id: number; name: string; }
export interface CategoryChanges {
  category: string;
  run_id: number | null;
  run_at: string | null;
  removed: CategoryChange[];
  added: CategoryChange[];
}
```

### 4.1 Backend Timestamp Handling — REQUIRED

Backend timestamps are `"YYYY-MM-DD HH:MM:SS"` in **UTC** **without** a timezone marker and are **not ISO 8601**. `new Date('2026-10-15 06:12:44')` is implementation-dependent and may parse as `Invalid Date` in Safari.

**Requirement:** provide a `formatTimestamp(value: string | null): string` utility that:
1. Returns `'—'` for `null`/empty.
2. Parses the string from its parts as **UTC**: the backend writes SQLite `CURRENT_TIMESTAMP`, which is UTC without a zone marker. Display converts to the viewer's local time (e.g. IST).
3. Renders via Angular `DatePipe` or `Intl.DateTimeFormat`; on parse failure returns the raw string rather than throwing.

---

## 5. Screens / Routes

Routes (`app.routes.ts`), all under the app shell. Lazy-load feature components via `loadComponent`.

| Path | Component | Purpose |
|---|---|---|
| `''` | redirect → `/leaderboard` | Default landing. |
| `leaderboard` | `Leaderboard` | Ranked consensus list + AI thesis/pros/cons (§6.1). Stock names link to `/stock/:stockId`. |
| `stock/:stockId` | `StockDetail` | One stock: stored scrape data + on-demand fundamentals (§6.5). |
| `signals` | `SellSignals` | Per-category removed/added changes (§6.2). |
| `funds` | `Funds` | Tracked funds table (§6.3). |
| `jobs` | `Jobs` | Scrape trigger + job monitor/history (§6.4). |
| `**` | `NotFound` | Friendly 404 with link back to leaderboard. |

### 5.1 App Shell

- `App` renders a persistent header/nav (links to the four features, active-route highlighting via `routerLinkActive`) and a `<router-outlet />`.
- Replace the Angular placeholder markup in `app.html` / `app.scss` entirely.
- Header shows a compact "current scrape" indicator (idle / running with stage / failed) fed by `JobMonitorService` (§7.3) so progress is visible on every route.

---

## 6. Feature Requirements

Model each feature with a small state machine: **`idle → loading → success | error`**, plus **`empty`** when the payload is an empty array. Every list screen must implement all states (see §8).

### 6.1 Leaderboard (`/leaderboard`)

**Must**
- On init, load `GET /api/stocks/leaderboard?limit=<pageSize>&offset=<offset>&category=<category>`.
- Render a table/list with columns: **Rank**, **Stock**, **Price**, **Consensus** (`consensus_score`), **Weight (avg · range)** (`weight_avg` / `weight_min` / `weight_max`), **Last analyzed** (`last_analyzed_at`).
- Render the stock's **live price** from `metrics.core_identifiers_and_market_metrics.live_price` (fall back to `—` when metrics are absent); link the row to `stock_url` (the Groww source page) when present.
- Provide a **Category filter** (dropdown) populated from `GET /api/categories`, plus an "All categories" option. Selecting a category re-requests the leaderboard with `category` and returns to page 1; the backend re-ranks within that category, so the top row answers "highest consensus in Small Cap".
- Show each row's `categories` as badges so a stock's cap memberships are visible.
- Render weight as the **average per-fund allocation** `weight_avg` with its `weight_min`–`weight_max` range, e.g. `1.24% (0.4–3.1%)`; show only the average when min equals max. Render `—` when `weight_avg` is `null` (no parsed weights) so real weights are never implied. Never display `total_weight_sum` — summing one stock's weight across dozens of funds yields a meaningless figure.
- Provide pagination controls (Previous / Next) backed by `limit`/`offset`. Default page size **20**; offer 10 / 20 / 50 (all within 1–100). Disable Next when a short page is returned (fewer than `limit` rows) — there is no total count, so use the short-page heuristic.
- Expand a row (or open a detail panel) to show the **scraped stock metrics** (price, valuation ratios, shareholding …) alongside `thesis`, `pros`, `cons`. Render the metrics generically from the object's groups/fields (humanized labels) so new config fields appear without a client change; skip null values.
- When `thesis` is `null` / `pros` & `cons` are empty, show an explicit **"AI analysis pending"** note (AI enrichment is disabled by default), not blank space.

**Should**
- Client-side sort by Rank / Consensus (server already orders by rank; sorting is a view affordance).
- Highlight rows that appear in current **sell signals** (cross-reference `SellSignalsService`, §7.4) with a badge like "Sell signal".

**Nice to have**
- Search/filter by stock name (client-side over the loaded page).

### 6.2 Sell Signals (`/signals`)

**Must**
- Discover categories (§3.9) from `GET /api/funds`.
- For each category, call `GET /api/categories/:category/changes` with `encodeURIComponent(category)`.
- Render, per category, the **`removed`** list as the primary **sell signal** (warning/red-accented card: *"XYZ Industries was removed from Flexi Cap — consider selling"*).
- Render `added` as a secondary, informational (neutral/green) list.
- Show `run_at` (formatted via §4.1) and `run_id` when present.
- When `run_id === null` / both lists empty, render **"No changes recorded for this category."**

**Should**
- Let the user select which categories to follow (persisted in `localStorage`); default to all discovered.
- Sort categories by most recent `run_at`.
- Tolerate one category failing without blanking the page (inline error on that card only).

**Nice to have**
- Collapse categories with no history.
- A top banner summarizing total removed/added across categories.

### 6.3 Funds (`/funds`)

**Must**
- Load `GET /api/funds` and render a table: **Name**, **Category**, **Last scraped** (formatted), with the fund `name` linking to `url` (`target="_blank"`, `rel="noopener noreferrer"`).
- Show an empty state when there are no funds yet (before the first scrape), pointing users to trigger a scrape.

**Should**
- Filter by category and/or sort by name / last-scraped.
- Visually flag funds whose `last_scraped_at` is `null` or stale (e.g. older than the daily cron window) as "never/needs refresh".

### 6.4 Scrape Control & Jobs (`/jobs`)

**Must**
- A **"Run scrape"** button that calls `POST /api/jobs/scrape`.
  - On `202`: store the returned `id`, begin polling.
  - On `409`: show the returned message (*"A scrape job is already running (job #N)"*) and switch to monitoring that job (fall back to the newest running job from `GET /api/jobs`).
  - Disable the button while polling an active job.
- Poll `GET /api/jobs/:id` on an interval (**default 3s**, configurable constant) while `status` is `queued`/`running`; **stop immediately** when `completed` or `failed`.
- Display `status` and `stage` with human labels:

| stage | label |
|---|---|
| `discovering_funds` | Discovering funds |
| `scraping_holdings` | Scraping holdings |
| `aggregating` | Aggregating consensus |
| `detecting_changes` | Detecting category changes |
| `completed` | Completed |
| `failed` | Failed |

- On `completed`: show `result` (funds, stocks, changes.added / changes.removed) and offer a **"Refresh data"** action that re-fetches leaderboard/funds/signals.
- On `failed`: show `error` text and allow retry.
- Render a **job history** table via `GET /api/jobs?limit=20`: id, status, stage, created/finished, error.

**Should**
- Show elapsed time from `started_at` and counters (`funds_found`, `stocks`) as they populate.
- Persist the active job id in `localStorage` so a page reload resumes polling.
- Show a "stale" warning if `GET /api/jobs/:id` returns `404` (job vanished) and move the button back to idle.

**Nice to have**
- Progress bar derived from stage order (4 stages).
- Terminal-style log of stage transitions observed client-side.

---

### 6.5 Stock Detail (`/stock/:stockId`)

Opened by clicking a stock name on the leaderboard. Loads **only stored data** first; fundamentals are fetched only when the user asks.

- **On load:** `GET /api/stocks/:id` (no external calls). Shows name, NSE symbol (once known), ISIN, sector; summary stats (funds holding, overall rank, per-fund weight avg and range, ₹ Cr held by funds, shares held, disclosure date); per-category coverage (`funds holding / funds in category` with a bar); recent category added/removed events; and every holding fund with weight (% NAV), shares, value (₹ Cr) and as-of date.
- **Fetch fundamentals button:** `GET /api/stocks/:id/fundamentals`. The backend calls its provider at most once per stock per day and serves its stored copy otherwise, so the button is safe to press repeatedly ("Fetch again"). Each section (profile, financials, shareholding, pledge) shows "Fresh" or "Stored" plus its fetch time, a "Stale" badge when the provider failed and an older copy was returned, and any per-section provider errors.
- **Charts (`shared/charts`):** hand-built SVG, no chart library. Headline tiles (price, market cap, P/E, P/B, ROE, ROCE, D/E, dividend yield, RSI) and a 52-week range bar from `profile`; a price line with 50/200-day averages plus computed return/volatility stats from `price_history`; quarterly revenue vs net profit columns from `financials`; holder-percentage lines from `shareholding` (zero rows such as an absent promoter group are dropped, with a note); and promoter pledge. Charts follow the dataviz rules: one y-axis, fixed categorical slots per entity (blue/orange/aqua/yellow, validated for colour-blind separation), legends for ≥2 series, crosshair/hover tooltips with arrow-key support, and 1 SVG unit = 1 CSS px so text stays 12px on phones.
- **Rendering provider data:** each section's raw data stays available under "Show data" (the table view behind every chart) and is rendered generically by `shared/data-view` (objects as label/value rows, arrays of records as tables, nested values recursively). Sections without a chart (e.g. analyst forecasts) show the table directly.
- **States:** loading skeleton; error with retry (404 / network); invalid id handled without an API call.

## 7. Services & State Management

All services are `providedIn: 'root'` unless noted, and expose state via signals.

### 7.1 `ApiService` (`core/api.ts`)

Single HTTP gateway. Responsibilities:
- Own the base path (`/api`).
- Typed methods: `getLeaderboard({limit, offset})`, `getFunds()`, `listJobs(limit)`, `getJob(id)`, `startScrape()`, `getCategoryChanges(category)`.
- **Clamp/validate** pagination params before issuing the request (§3.2).
- Return `Observable<T>`; do **not** swallow errors.
- Normalize non-2xx responses into an error carrying the backend `{ error }` message when present.

### 7.2 Central Error Handling

Provide a functional `HttpInterceptorFn` (`core/error.interceptor.ts`) registered via `provideHttpClient(withInterceptors([...]))` that:
- Extracts the `{ error: string }` message from `HttpErrorResponse` and rethrows a typed `ApiError { status, message }`.
- Leaves `409` and `400` messages intact so features render them verbatim.
- Does **not** show global toasts; features own their presentation.

### 7.3 `JobMonitorService` (`core/job-monitor.ts`)

- Holds the active job as a signal and drives polling (§6.4).
- Exposes computed `isRunning`, `stageLabel`, `progress`.
- Consumed by the app shell (§5.1) and the Jobs page.
- Polling lives in a service (not a component) and MUST cancel on completion/failure and on `DestroyRef` teardown.

### 7.4 `SellSignalsService` (`core/sell-signals.ts`)

- Loads per-category changes, keeps `removed` names in a `Set<string>` computed signal for leaderboard badge cross-referencing (§6.1 Should).

### 7.5 Data Refresh Strategy

- Read endpoints are **not** live; there is no websocket/SSE. Refetch on: route activation, explicit "Refresh" controls, and after a scrape job completes.
- Avoid duplicate in-flight requests for the same endpoint (share via `shareReplay(1)` or a signal guard).

---

## 8. Cross-Cutting UX Requirements

For every data screen, implement four states:

1. **Loading** — skeleton rows or a spinner; never a blank flash.
2. **Empty** — explicit message ("No funds tracked yet — run a scrape"), with a CTA where relevant.
3. **Error** — inline message using the backend `{ error }` text where available, plus a **Retry** button. Never leak a raw stack or `[object Object]`.
4. **Success** — rendered data.

Additional requirements:
- **Accessibility:** semantic tables (`<table>`/`<th scope>`), labelled controls, visible focus states, `aria-live="polite"` for job status updates, and color-independent sell-signal cues (icon + text, not color alone).
- **Responsiveness:** usable at ≥ 360px; tables may collapse to stacked cards on narrow viewports.
- **Number formatting:** ranks/scores as integers; do not fabricate decimals for weights (Groww returns `0`).
- **No dead links:** external fund URLs open in a new tab with `rel="noopener noreferrer"`.

---

## 9. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-1 | `ng build` (production) succeeds with **no TypeScript errors** under the strict tsconfig flags. |
| NFR-2 | `ng test` passes; new components/services have unit tests (§10). |
| NFR-3 | Leaderboard default page (20 rows) renders within 2s on a local backend. |
| NFR-4 | Poll interval ≥ 1s and ≤ 5s; polling stops on terminal status (no runaway timers). |
| NFR-5 | No hard-coded backend host in components/services; base path configurable (§3.1). |
| NFR-6 | No new runtime dependencies without approval (§2.1). |
| NFR-7 | API data rendered safely (Angular interpolation only; no `innerHTML` for API strings). |
| NFR-8 | Prettier-formatted; matches scaffold conventions (§2.2). |

---

## 10. Test Plan (Vitest)

**Service tests**
- `ApiService`: builds correct URLs/query params; clamps `limit`/`offset`; encodes category names.
- `error.interceptor`: maps `{ error }` bodies and status codes to `ApiError`.
- `JobMonitorService`: polls until `completed`/`failed`, stops on terminal status, resumes from a persisted id, handles `404`.
- Timestamp utility: `null` → `—`, valid string → formatted, malformed string → raw fallback.

**Component tests**
- `Leaderboard`: renders rows; empty state; "AI analysis pending" when enrichment absent; renders `—` for zero weight; Next disabled on short page.
- `SellSignals`: removed rendered as sell signals; empty-history message when `run_id` null; one failing category does not break others.
- `Funds`: renders table; empty state; external links have `target`/`rel`.
- `Jobs`: 202 starts polling; 409 shows message and disables button; completed shows result; failed shows error + retry.

Use `HttpTestingController` (`provideHttpClientTesting()`) to stub all backend calls; no live network in unit tests.

---

## 11. Delivery Plan (Suggested Phases)

1. **Foundation** — dev proxy (§3.1), `provideHttpClient`, models (§4), `ApiService`, error interceptor, timestamp util, app shell + routes.
2. **Leaderboard** — read model, states, pagination, AI panel. *(Highest user value.)*
3. **Funds** — table + states.
4. **Jobs** — trigger, poll, history, shell indicator.
5. **Sell Signals** — category discovery, per-category changes, leaderboard cross-references.
6. **Polish** — accessibility, responsiveness, tests to NFR-2 coverage.

---

## 12. Acceptance Criteria (Definition of Done)

- [ ] Angular app builds (`ng build`) and tests (`ng test`) pass; no strict-mode errors.
- [ ] App consumes the backend via a proxied relative `/api` base (or approved CORS), with no hard-coded host.
- [ ] Leaderboard renders ranked rows with correct score/rank, loading/empty/error states, an explicit "AI pending" note when enrichment is absent, and a **category filter** that re-ranks within "Large Cap"/"Small Cap"/etc.
- [ ] Weight shows the per-fund average `weight_avg` with its `weight_min`–`weight_max` range and falls back to `—` only when `weight_avg` is `null` (never implying weights exist when none were parsed; `total_weight_sum` is never displayed).
- [ ] Leaderboard rows show the scraped **live price** (from `metrics`), link to `stock_url`, and expanding a row reveals the full scraped metric set (price, ratios, shareholding …) rendered generically from the config-driven groups/fields.
- [ ] Sell Signals page lists category `removed` stocks as sell signals and handles the null/empty response for unknown or unchanged categories without erroring.
- [ ] Funds page lists tracked funds with formatted timestamps and safe external links.
- [ ] Jobs page triggers a scrape (202), polls to completion/failure, shows stage/result/error, and reflects status in the app shell.
- [ ] Timestamps render correctly (no `Invalid Date`) for backend `"YYYY-MM-DD HH:MM:SS"` values.
- [ ] All four data screens implement loading/empty/error/retry states.
- [ ] Unit tests cover the services and the four feature components per §10.

---

## 13. Open Questions / Assumptions

1. **CORS/proxy** (§3.1): assumed a dev proxy is acceptable; confirm whether adding backend CORS is desired for production hosting.
2. **Production hosting**: is the Angular build served by the Node backend, a separate static host, or a reverse proxy? This determines the base path (relative vs absolute) and any `baseHref`.
3. **Followed-category persistence** (§6.2): `localStorage` proposed; confirm no server-side user profile is needed.
4. **Weight display** (§6.1): with Groww always returning `0`, confirm hiding the weight column entirely is preferable to showing `—`.
5. **Poll interval** (§6.4): 3s proposed; confirm acceptable given scrapes run for minutes.
6. **Auth**: assumed none; confirm the client will not need a login screen.

