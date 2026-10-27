# Backend Feature & API Reference

Complete reference for the Stock Recommender backend: what it does, how the pieces fit together, and every REST endpoint with its request/response payloads. All examples assume the server is running at `http://localhost:3300`.

---

## 1. Features

### 1.1 Automated Fund Discovery
On every scrape run, the backend visits the Groww mutual-fund filter pages for **seven categories** — Mid Cap, Large Cap, Small Cap, ELSS, Thematic, Value Oriented, Flexi Cap — evaluates the configured XPath against the listing page, and reads each matched `<a>` node's text (fund name) and `href` (fund link). Funds are **upserted** into the `funds` table, de-duplicated by URL, with the first-seen category recorded. A fund listed under two categories keeps its first category; its name is refreshed on every discovery.

### 1.2 Holdings Extraction
For every tracked fund the backend opens the fund's detail page and extracts the holdings table via the configured XPath. For each row it stores:
- `stock_name` — trimmed and whitespace-normalized before upsert into `stocks`.
- `weight_percentage` — the **Assets** column of Groww's holdings table (e.g. `1.75`), or `null` if the cell is missing/unparsable.

Groww's holdings table is read row-by-row (`Name | Sector | Instruments | Assets`); every configured column is read and an unreadable/missing column degrades to `null` rather than failing the row. The row's stock link (`stock_url`, the `//a/@href` of the company-name cell) is also captured — it is what lets each stock's own detail page be visited (§1.10). Holdings are replaced atomically per fund (delete-then-insert in one transaction, with duplicate rows de-duplicated), and the fund's `last_scraped_at` is stamped. Each run refreshes the entire portfolio snapshot.

### 1.3 Consensus Aggregation
After holdings are refreshed, a SQL pass recomputes the cross-fund leaderboard in `stock_aggregations`:
- `consensus_score` — number of distinct funds holding the stock.
- `weight_avg` / `weight_min` / `weight_max` — the **per-fund** Assets % statistics: the average a single holding fund allocates to the stock, and the min/max across those funds (its range). `null` when no holding carries a parsable weight. These are what the leaderboard renders.
- `total_weight_sum` — raw sum of weights across funds. Retained for compatibility and internal ordering only; it is **not** a meaningful display figure (a stock held by 50 funds at ~1% each would sum to ~50), so the API and UI expose the per-fund stats instead.
- `rank` — ordered by consensus score, then total weight.

When a stock's score or weight changes, its `last_analyzed_at` is reset so AI re-enrichment picks it up.

The leaderboard can also be **scoped to one fund category** (`GET /api/stocks/leaderboard?category=Small%20Cap`): consensus and rank are recomputed from that category's funds only, so the response answers "which stock is #1 among Small Cap funds" — not just the global ranking. Each row also carries `categories`, the list of every category holding the stock.

### 1.4 AI Enrichment (optional, disabled by default)
When `ai.enabled` is `true` in `config/app.json`, the top `ai.top_stock_limit` (default 20) un-analyzed stocks are sent to a local LLM endpoint (Ollama-compatible) with a structured prompt. Alongside fund-membership data (consensus score, per-fund allocation weight with its range), the prompt includes the **scraped stock-page fundamentals** (price, valuation ratios, financial trends, shareholding …) so the model reasons over the real business, not just who holds it. The response is validated to contain `thesis` (string), `pros` (array), and `cons` (array) and persisted into `stock_aggregations`. A failed/invalid LLM response aborts the scrape job (recorded as `failed`), so junk never lands in the leaderboard.

### 1.5 Category Change Detection (Sell Signals)
After aggregation, the job compares each category's **current** stock set (distinct stocks held by funds in that category) against the stored baseline in `category_stocks`:
- A stock in the baseline but no longer held by any fund of the category → **removed** event (the *sell signal*: exit a position taken on that category's consensus).
- A stock newly held → **added** event.

If any change occurred, the run is logged in `category_change_runs` / `category_stock_changes` and the baseline is updated. A no-change run records nothing. Exposed via `GET /api/categories/:category/changes` (§2.7).

### 1.6 Async Scrape Jobs with Monitoring
A scrape drives a headless browser across many pages and takes minutes, so triggering it never blocks the HTTP request:
- `POST /api/jobs/scrape` starts the work **in the background** and immediately returns `202` with a job record.
- Job state is persisted in `scrape_jobs` (`queued → running → completed | failed`) with a `stage` progress field (`discovering_funds`, `scraping_holdings`, `aggregating`, `detecting_changes`, `completed`, `failed`).
- Only one scrape runs at a time — a second trigger while one is active returns `409`.
- A job left `running` by a crash is automatically marked `failed` on the next server startup, so it can never permanently block new scrapes.

### 1.7 Scheduled Runs
The same pipeline runs automatically on the `scrape_cron` cron expression (default `0 6 * * *` — daily at 06:00). Invalid cron expressions fail fast at startup.

### 1.8 Pluggable Source Adapters
The scraper is source-agnostic. A source implements `supports(url)` plus `discoverFunds(page)` and `scrapeFundHoldings(page, fund)`, and is registered in `src/scrapers/sourceRegistry.js`. `groww` and `moneycontrol` are registered; `config/scraping.json` picks one via `source`, and the registry resolves the adapter per category URL. XPath reads are **bounded and tolerant**: a short per-read timeout and try/catch so an element that detaches mid-read (a common race on Groww's client-rendered SPA) resolves to `null`/skipped instead of crashing the job.

---

### 1.9 Selector Dry Run (Heat-and-Trial)
Full scrapes take minutes, which makes tuning `config/scraping.json` XPaths painful. `GET /api/scrape/dry-run` runs a **read-only micro-scrape** for selector experimentation:
- Picks **one category** (default: the first, `Mid Cap`) and **one fund** of it (the first, or a fund chosen by index/name).
- Parses **at most `limit` holdings** (default 5) and returns *every* data point it read for each — `{ name, sector, instrument, weightPercentage, url }`.
- **Follows each listed holding to its own stock detail page** and attaches the full `metrics` blob plus `metrics_provenance` (the strategy that produced each value), exactly as the full scrape persists it.
- Reports `funds_found` and `holdings_found` (the true count before the `limit` cut) plus `diagnostics` (e.g. "0 rows matched", "N holdings have no parsable weight", "N holdings have no stock detail URL") so a broken selector is obvious.
- **Nothing is persisted** — no fund/holding/stock rows, no scrape job — so it is safe to call repeatedly while iterating.

Use `GET /api/scrape/categories` to list the categories the dry run can sample.

### 1.10 Stock Page Metrics (price + fundamentals)
After holdings are refreshed, the stock scraper collects the **unique stocks** across all funds and visits each one's Groww detail page (the `stock_url` captured in §1.2, de-duplicated and optionally capped by `scrape.stock_limit`). On each page it extracts every metric declared under `selectors.stock_page.metrics` — core identifiers and market metrics (ticker, live price, 52-week range, market cap), valuation ratios (P/E, industry P/E, EPS, P/B, book value, ROE, dividend yield), financial performance trends, shareholding pattern, corporate actions, filings and peer benchmarks — and persists them per stock in `stock_metrics` as a JSON blob keyed by the config's group/field names.

Resolution is **layered and self-describing** — for each metric the extractor tries, in order: the configured XPath, `hints.<metric>.xpaths` fallbacks, `hints.<metric>.labels` visible-text matches (reads the next sibling), then the page's embedded `__NEXT_DATA__` JSON via `hints.<metric>.payload`. The winning strategy is stored per metric in `provenance`, so a dry run shows exactly how each value was obtained. A stock page that fails to load is logged and skipped — it never aborts the scrape. Metrics surface on the leaderboard (`metrics`, `stock_url`), on `GET /api/stocks/:id/metrics` (§2.2) and in the LLM prompt (§1.4).

---

## 2. REST API

Every response is JSON. Errors use `{ "error": "<message>" }` with status `400` (bad pagination params), `404` (unknown job id), `409` (scrape already running), or `500` (unexpected).

### 2.1 `GET /api/stocks/leaderboard`

Ranked list of aggregated stocks — the primary read model for the frontend.

**Query parameters**

| Param | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `limit` | integer | `20` | 1–100 | Max rows to return. |
| `offset` | integer | `0` | 0–1000000 | Rows to skip (pagination). |
| `category` | string | *(none)* | any tracked category | Scope the ranking to funds of this category (e.g. `Small Cap`, URL-encoded). Omit for the global ranking. |

**Response `200`** — array of:

```json
{
  "stock_id": 42,
  "name": "HDFC Bank",
  "consensus_score": 12,
  "weight_avg": 1.24,
  "weight_min": 0.4,
  "weight_max": 3.1,
  "total_weight_sum": 14.9,
  "rank": 1,
  "stock_url": "https://groww.in/stocks/hdfc-bank-ltd",
  "metrics": {
    "core_identifiers_and_market_metrics": { "live_price": "₹728.85", "market_cap": "₹11,23,322Cr" },
    "valuation_and_fundamental_ratios": { "pe_ratio": "13.62", "roe": "13.14%" }
  },
  "thesis": "Widely held across large-cap funds...",
  "pros": ["pro 1", "pro 2", "pro 3"],
  "cons": ["con 1", "con 2", "con 3"],
  "last_analyzed_at": "2026-10-15 06:12:44",
  "categories": ["Large Cap", "Flexi Cap"]
}
```

`thesis`/`pros`/`cons` are `null`/`[]` until AI enrichment has run for that stock. `categories` lists every category holding the stock (for per-row badges).

`stock_url` is the stock's own Groww detail page (captured from the fund's holdings table) and `metrics` is the full metric set scraped from that page (§1.10), keyed by the groups/fields in `selectors.stock_page.metrics`. Both are `null` until that stock has been visited by a scrape. The same metrics are fed to the LLM prompt (§1.4), so AI analysis reasons over real fundamentals rather than fund membership alone.

When `category` is supplied, `consensus_score` counts only that category's funds and `rank` is recomputed within the category — so the top row is *the* highest-consensus stock among that category's funds, not merely a globally-ranked row that happens to qualify.

**Errors:** `400` for a non-numeric or out-of-range `limit`/`offset`.

```sh
curl 'http://localhost:3300/api/stocks/leaderboard?limit=10&offset=0'
curl 'http://localhost:3300/api/stocks/leaderboard?category=Small%20Cap&limit=10'
```

### 2.2 `GET /api/stocks/:id/metrics`

The full metric set scraped from one stock's own Groww detail page — price, valuation ratios, financial trends, shareholding, corporate actions, filings and peers.

**Path params:** `id` (integer) — the `stock_id` from the leaderboard.

**Response `200`**:

```json
{
  "stock_id": 42,
  "name": "HDFC Bank",
  "stock_url": "https://groww.in/stocks/hdfc-bank-ltd",
  "page_title": "HDFC Bank",
  "metrics": {
    "core_identifiers_and_market_metrics": {
      "ticker_and_exchange": "HDFC Bank",
      "live_price": "₹728.85",
      "fifty_two_week_high_low": { "low": 681.9, "high": 1020.5 },
      "market_cap": "₹11,23,322Cr"
    },
    "valuation_and_fundamental_ratios": { "pe_ratio": "13.62", "roe": "13.14%" }
  },
  "provenance": { "live_price": "hint", "pe_ratio": "payload" },
  "updated_at": "2026-10-15 06:09:01"
}
```

`metrics` is `null` until that stock has been visited by a scrape (i.e. `stock_url` was captured). `provenance` records which strategy in `selectors.stock_page` produced each value: `xpath` (the configured metric XPath), `hint` (a `hints.<metric>.xpaths` fallback), `label` (a `hints.<metric>.labels` text match), `payload` (the embedded `__NEXT_DATA__` JSON) or `none` (not found).

**Errors:** `404` for an unknown `stock_id`.

```sh
curl 'http://localhost:3300/api/stocks/42/metrics'
```

### 2.3 `GET /api/funds`

All tracked mutual funds with their last scrape timestamp, ordered by name.

**Request body / query params:** none.

**Response `200`** — array of:

```json
{
  "id": 7,
  "name": "Example Large Cap Fund",
  "url": "https://groww.in/mutual-funds/example-large-cap-fund",
  "category": "Large Cap",
  "last_scraped_at": "2026-10-15 06:09:01"
}
```


### 2.4 `POST /api/jobs/scrape`

Manually trigger the full pipeline: fund discovery → holdings extraction → aggregation → (optional AI) → category change detection. The work runs in the background; the call returns immediately.

**Request body / query params:** none.

**Response `202`** — the freshly created job record:

```json
{
  "id": 5,
  "status": "queued",
  "stage": null,
  "funds_found": null,
  "stocks": null,
  "result": null,
  "error": null,
  "created_at": "2026-10-15 10:02:11",
  "started_at": null,
  "finished_at": null
}
```

**Errors:** `409 { "error": "A scrape job is already running (job #4)" }` when a queued/running job exists.

```sh
curl -X POST http://localhost:3300/api/jobs/scrape
```

### 2.5 `GET /api/jobs/:id`

Poll a scrape job's progress.

**Path parameters**

| Param | Description |
|---|---|
| `id` | Numeric job id from `POST /api/jobs/scrape`. |

**Response `200`** — same shape as §2.3; once completed, `result` is populated:

```json
{
  "id": 5,
  "status": "completed",
  "stage": "completed",
  "funds_found": 42,
  "stocks": 310,
  "result": {
    "funds": 42,
    "stocks": 310,
    "changes": { "added": 4, "removed": 2 }
  },
  "error": null,
  "created_at": "2026-10-15 10:02:11",
  "started_at": "2026-10-15 10:02:12",
  "finished_at": "2026-10-15 10:07:33"
}
```

`result.changes` counts the per-category stock additions/removals detected at the end of the run. On failure, `status` is `failed`, `stage` is `failed`, and `error` holds the message.

**Errors:** `404 { "error": "Scrape job #99 not found" }` for an unknown/non-numeric id.

```sh
curl http://localhost:3300/api/jobs/5
```

### 2.6 `GET /api/jobs?limit=20`

List recent scrape jobs, newest first.

**Query parameters**


### 2.7 `GET /api/categories/:category/changes`

Report how a category's stock membership changed in the most recent detection run — the frontend uses `removed` as the **sell signal**.

**Path parameters**

| Param | Description |
|---|---|
| `category` | Category name, URL-encoded (e.g. `Flexi%20Cap`, `Value%20Oriented`). Case-sensitive; must match the name stored on the funds. |

**Response `200`** — with history:

```json
{
  "category": "Flexi Cap",
  "run_id": 12,
  "run_at": "2026-10-15 06:11:02",
  "removed": [
    { "stock_id": 87, "name": "XYZ Industries" }
  ],
  "added": [
    { "stock_id": 91, "name": "ABC Retail" },
    { "stock_id": 95, "name": "PQR Energy" }
  ]
}
```

With no recorded history for the category (never changed since tracking began, or unknown category name):

```json
{
  "category": "Nonexistent",
  "run_id": null,
  "run_at": null,
  "removed": [],
  "added": []
}
```

Note: an unknown category name is **not** a `404` — it returns the empty shape above.

```sh
curl 'http://localhost:3300/api/categories/Flexi%20Cap/changes'
```

### 2.8 `GET /api/categories`

The distinct non-null fund categories, ordered — the leaderboard's category filter options.

**Query params:** none.

**Response `200`**:

```json
["ELSS", "Flexi Cap", "Large Cap", "Mid Cap", "Small Cap", "Thematic", "Value Oriented"]
```

### 2.9 `GET /api/scrape/dry-run`

Read-only selector heat-and-trial (§1.9): scrape **one category → one fund → up to `limit` holdings**, returning every parsed data point. Nothing is persisted.

**Query parameters**

| Param | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `category` | string | first configured | must be a configured category | Category to sample (name or 0-based index). Unknown → `400` listing the available categories. |
| `fund` | string | first fund | name (substring) or 0-based index | Which of the category's funds to scrape. No match → `fund: null` with a diagnostic. |
| `limit` | integer | `5` | 1–50 | Max holdings to list (`holdings_found` still reports the true total). |

**Response `200`**:

```json
{
  "category": { "name": "Small Cap", "url": "https://groww.in/mutual-funds/filter?sub_cat=%5B%22Small+Cap%22%5D" },
  "fund": { "name": "Bandhan Small Cap Fund", "url": "https://groww.in/mutual-funds/bandhan-small-cap-fund-direct-growth", "index": 0 },
  "limit": 5,
  "funds_found": 10,
  "holdings_found": 269,
  "holdings": [
    {
      "name": "Sobha Ltd",
      "sector": "Real Estate",
      "instrument": "Equity",
      "weightPercentage": 2.3,
      "url": "https://groww.in/stocks/sobha-ltd",
      "metrics": {
        "core_identifiers_and_market_metrics": {
          "ticker_and_exchange": "Sobha",
          "live_price": "₹1,188.40",
          "fifty_two_week_high_low": { "low": 1130, "high": 1732 },
          "market_cap": "₹12,752Cr"
        },
        "valuation_and_fundamental_ratios": {
          "pe_ratio": "55.29", "industry_pe": "31.94", "eps_ttm": "21.57",
          "pb_ratio": "2.70", "book_value": "441.39", "roe": "4.10%", "dividend_yield": "0.50%"
        }
      },
      "metrics_provenance": { "live_price": "hint", "pe_ratio": "payload" }
    }
  ],
  "diagnostics": ["Showing the first 5 of 269 parsed holding(s)."]
}
```

Each listed holding is followed to **its own stock detail page** (`url`), where every metric configured under `selectors.stock_page.metrics` is extracted — price, valuation ratios, financial trends, shareholding, corporate actions, filings and peers. `metrics_provenance` records which config strategy produced each value (`xpath`, `hint`, `label`, `payload` or `none`), which is what makes selector tuning concrete. Metrics are only fetched for holdings whose `stock_url` resolved; repo/cash artifacts have no stock page and report `metrics: null`.

A run that matches no rows, rows without parsable weights, or (unresolved) stock URLs explains itself in `diagnostics` instead of silently returning an empty list.

```sh
curl 'http://localhost:3300/api/scrape/dry-run?category=Small%20Cap&limit=5'
curl 'http://localhost:3300/api/scrape/dry-run?category=Small%20Cap&fund=Quant&limit=5'
```

### 2.10 `GET /api/scrape/categories`

The categories a dry run can sample (the canonical list from `config/scraping.json`).

**Response `200`**:

```json
["Mid Cap", "Large Cap", "Small Cap", "ELSS", "Thematic", "Value Oriented", "Flexi Cap"]
```

---

## 3. Typical Frontend Flow

1. `POST /api/jobs/scrape` → read `id` from the `202` response.
2. Poll `GET /api/jobs/:id` until `status` is `completed` or `failed` (or just read the data below — the leaderboard/changes endpoints always serve the latest persisted state).
3. `GET /api/stocks/leaderboard?limit=20` → render the consensus ranking with thesis/pros/cons.
4. `GET /api/categories/:category/changes` for each category the user follows → show *"XYZ was removed from Flexi Cap — consider selling"* alerts.

---

## 4. Configuration Reference

Environment variables override `config/*.json`: `APP_CONFIG`, `SCRAPING_CONFIG`, `PORT`, `DATABASE_PATH` (paths relative to `backend/`).

| Key | Default | Purpose |
|---|---|---|
| `port` | `3300` | API listen port. |
| `database_path` | `./data/stocks.sqlite` | SQLite file (auto-created). |
| `scrape_cron` | `0 6 * * *` | Scheduled scrape (node-cron expression); empty disables. |
| `ai.enabled` | `false` | Enable local-LLM enrichment. |
| `ai.baseUrl` | `http://127.0.0.1:1234` | Ollama-compatible endpoint. |
| `ai.model` | `ornith-1.5-9b` | Model name sent to the LLM. |
| `ai.top_stock_limit` | `20` | Max un-analyzed stocks enriched per run. |
| scraping `source` | `groww` | Registered adapter to use (`groww` or `moneycontrol`). |
| scraping `categories[]` | 7 Groww categories | `{ category, url, xpath? }`; `xpath` falls back to `selectors.mf_list_page.fund_row`. |
| scraping `browser.headless` | `true` | Run Playwright headless. |
| scraping `browser.*_timeout_ms` | 30000 / 10000 | Navigation / action timeouts. |
| scraping `scrape.fund_limit` | `0` | Cap funds scraped per run (`0` = no limit). |
| scraping `scrape.stock_limit` | `0` | Cap stock detail pages visited per run (`0` = every collected stock). |
| scraping `selectors.mf_detail_page.*` | Groww table columns | `holding_row` (one `<tr>`) plus `stock_name`/`stock_sector`/`stock_instrument`/`stock_weight`/`stock_url`, each relative to the row. `stock_url` (the row's `//a/@href`) is what lets each stock detail page be visited. Missing/blank cell → `null`. Tune these with `GET /api/scrape/dry-run`. |
| scraping `selectors.stock_page.metrics` | 7 metric groups | The per-stock-page XPaths to extract (core identifiers/price, valuation ratios, financial trends, shareholding, corporate actions, filings, peers). Each field's value is the XPath; unpredicated node-sets (e.g. `...//tr`) return the list of matched rows. |
| scraping `selectors.stock_page.hints` | per-metric fallbacks | Optional `xpaths`/`labels`/`payload` alternative strategies used when a metric's primary XPath matches nothing. `labels` matches visible text (e.g. `Market Cap`) and reads the next sibling. |
| scraping `selectors.stock_page.payload_root` | `props.pageProps.stockData` | Path into Groww's embedded Next.js `__NEXT_DATA__` JSON. `selectors.stock_page.payload` names the sub-sections exposed verbatim (details, financials, shareholding, peers, price range); `hints.<metric>.payload` reads individual metric values from it. |
| scraping `selectors.stock_page.wait_ms` | `2500` | Settle time after navigation before extracting metrics (Groww is client-rendered). |

## 5. Quick Start

```sh
cd backend
npm install
npx playwright install chromium
npm start                                     # API on :3300, cron scheduled

# 1. Tune selectors fast (read-only, ~10s per call):
curl 'localhost:3300/api/scrape/dry-run?category=Small%20Cap&limit=5'
curl 'localhost:3300/api/scrape/categories'

# 2. Kick off a full scrape once the dry run looks right:
curl -X POST localhost:3300/api/jobs/scrape
curl localhost:3300/api/jobs/1                # poll until completed
curl 'localhost:3300/api/stocks/leaderboard?limit=10'
curl 'localhost:3300/api/stocks/leaderboard?category=Small%20Cap&limit=10'
curl 'localhost:3300/api/categories/Flexi%20Cap/changes'
```

