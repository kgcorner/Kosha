# Kosha Backend — API Reference

Kosha ranks stocks by how many actively managed mutual funds hold them (from official AMC monthly portfolio disclosures), tracks how that changes, and, on request, adds stock fundamentals and an AI verdict.

- **Base URL:** `http://localhost:5100/api` (port from `config/app.json` → `port`, or the `PORT` env var)
- **Format:** JSON request and response bodies. No authentication; the API is meant to run on your own machine.
- **Timestamps:** UTC, `YYYY-MM-DD HH:MM:SS` (SQLite `CURRENT_TIMESTAMP`, no zone marker). Convert to local time for display.

## Contents

| Area | Method & path | Purpose |
|---|---|---|
| Stocks | [`GET /stocks/leaderboard`](#get-stocksleaderboard) | Consensus ranking, optionally per category |
| | [`GET /stocks/:id`](#get-stocksid) | Everything the scrape stored about one stock (no external calls) |
| | [`GET /stocks/:id/fundamentals`](#get-stocksidfundamentals) | Fundamentals, fetched on demand (Tapetide), at most once per stock per day |
| | [`GET /stocks/:id/analysis`](#get-stocksidanalysis) | AI verdict (BUY/IGNORE or HOLD/SELL), on demand and cached |
| | [`GET /stocks/:id/metrics`](#get-stocksidmetrics) | Scraped stock-page metrics (HTML sources only) |
| Funds & categories | [`GET /funds`](#get-funds) | Tracked funds |
| | [`GET /categories`](#get-categories) | Categories that have funds in the database |
| | [`GET /categories/:category/changes`](#get-categoriescategorychanges) | Stocks added to / removed from a category in the last run that changed it |
| Scrape jobs | [`POST /jobs/scrape`](#post-jobsscrape) | Start a scrape in the background |
| | [`GET /jobs/:id`](#get-jobsid) | Poll one job |
| | [`GET /jobs`](#get-jobs) | Recent jobs |
| Diagnostics | [`GET /scrape/dry-run`](#get-scrapedry-run) | Read-only sample of one fund's holdings |
| | [`GET /scrape/categories`](#get-scrapecategories) | Categories configured for scraping |

## Conventions

### Errors

Every error has the shape:

```json
{ "error": "Human-readable message" }
```

The fundamentals and analysis endpoints add a machine-readable `code` where useful.

| Status | When |
|---|---|
| `400` | Bad query parameter (non-integer or out-of-range `limit`/`offset`, unknown dry-run category, unknown fundamentals section) |
| `404` | Unknown stock id or job id |
| `409` | `POST /jobs/scrape` while a scrape is already running |
| `429` | The LLM provider rate-limited the analysis request |
| `502` | The LLM call failed or returned unusable output |
| `503` | Fundamentals or LLM provider not configured (missing key) |
| `500` | Unexpected server error |

### Environment variables

Secrets are read from the environment only; never put them in config files.

| Variable | Needed for | Notes |
|---|---|---|
| `TAPETIDE_TOKEN` | `/stocks/:id/fundamentals` (and analysis) | Personal token from tapetide.com → Settings → Tokens (`tpt_rt_...`) |
| `OPENROUTER_API_KEY` | `/stocks/:id/analysis` | Name set by `ai.api_key_env`; not needed for a local LM Studio/Ollama server |
| `DATABASE_PATH`, `PORT`, `APP_CONFIG`, `SCRAPING_CONFIG` | Optional overrides | Paths are relative to `backend/` |

### Identifiers

- `stock_id` / `:id`: Kosha's internal stock id (from the leaderboard or changes).
- Stocks from the default source are matched across funds by **ISIN**, so spelling variants ("Ltd." / "Limited") count as one stock. The display `name` is the first spelling seen.

---

## Stocks

### `GET /stocks/leaderboard`

Stocks ranked by fund consensus: the number of distinct tracked funds holding the stock, then total weight.

**Query parameters**

| Name | Type | Default | Notes |
|---|---|---|---|
| `limit` | integer | `20` | 1–100 |
| `offset` | integer | `0` | 0–1,000,000 |
| `category` | string | — | Rank only within funds of this category, e.g. `Small Cap` (URL-encode spaces). Omit for all funds. |

**Response `200`**: array of rows.

```json
[
  {
    "stock_id": 379,
    "name": "City Union Bank Ltd",
    "stock_url": null,
    "consensus_score": 24,
    "total_weight_sum": 41.115207,
    "weight_avg": 1.713133625,
    "weight_min": 0.38,
    "weight_max": 3.23,
    "rank": 1,
    "thesis": null,
    "pros": [],
    "cons": [],
    "last_analyzed_at": null,
    "metrics": null,
    "categories": ["Mid Cap", "Small Cap", "ELSS", "Thematic", "Value Oriented", "Flexi Cap"]
  }
]
```

| Field | Meaning |
|---|---|
| `consensus_score` | Distinct funds holding the stock (within `category` when given) |
| `weight_avg` / `weight_min` / `weight_max` | Per-fund weight (% of fund NAV) across holding funds. Use these for display. |
| `total_weight_sum` | Sum of weights across funds; for ordering only, **not meaningful to display** |
| `rank` | 1-based position in this ranking |
| `thesis`, `pros`, `cons`, `last_analyzed_at` | Optional scrape-time AI thesis (`ai.scrape_thesis.enabled`); empty when disabled |
| `stock_url`, `metrics` | Stock page and scraped metrics; `null` for the default (API) source |
| `categories` | Every category in which at least one tracked fund holds the stock |

```sh
curl 'http://localhost:5100/api/stocks/leaderboard?category=Small%20Cap&limit=10'
```

---

### `GET /stocks/:id`

Everything the scrape stored about one stock, for a detail page. Reads only Kosha's database; never calls an external service.

**Response `200`**

```json
{
  "stock": { "id": 419, "name": "KARUR VYSYA BANK LTD.", "isin": "INE036D01028", "symbol": "KARURVYSYA", "sector": "Banks", "url": null },
  "totals": { "funds_holding": 76, "total_quantity": 412345678, "total_market_value_cr": 9950.4, "latest_as_of": "2026-09-30" },
  "holdings": [
    { "fund_id": 12, "fund_name": "Example Small Cap Fund", "category": "Small Cap", "weight_percentage": 3.56, "quantity": 12000000, "market_value_cr": 289.4, "as_of": "2026-09-30" }
  ],
  "recent_changes": [
    { "category": "Small Cap", "change_type": "added", "run_at": "2026-10-27 15:55:02", "run_id": 1 }
  ],
  "fundamentals_cached": [ { "section": "profile", "fetched_at": "2026-10-28 03:40:12" } ],
  "fund_signal": {
    "funds_holding": 76, "rank": 2, "weight_avg": 1.95, "weight_min": 0.13, "weight_max": 3.56,
    "categories": [ { "category": "Small Cap", "funds_holding": 22, "funds_in_category": 36, "weight_avg": 1.95 } ]
  }
}
```

| Field | Meaning |
|---|---|
| `stock.sector` | Industry as disclosed by the first fund seen holding it |
| `stock.symbol` | NSE symbol; `null` until fundamentals have been fetched once |
| `totals` | Distinct holding funds; shares and market value (₹ crore) summed across them; latest disclosure date |
| `holdings` | One row per holding fund, highest weight first. `quantity`, `market_value_cr` and `as_of` are `null` for sources that don't publish them (and for data scraped before these columns existed, until the next scrape) |
| `recent_changes` | Category add/remove events for this stock, newest run first (max 50) |
| `fundamentals_cached` | Fundamentals sections already stored, with fetch time; empty if never fetched |
| `fund_signal` | Same structure as in [`/fundamentals`](#get-stocksidfundamentals) |

`404` for an unknown or non-numeric id.

```sh
curl 'http://localhost:5100/api/stocks/419'
```

---

### `GET /stocks/:id/fundamentals`

Fundamentals for one stock plus Kosha's fund signal. **Lazy:** the provider (Tapetide) is called only when this endpoint is requested, never by the scrape job.

**Once per day:** every provider response is stored in SQLite. A section is fetched from the provider only if its stored copy was fetched on an earlier calendar day (timezone `fundamentals.timezone`, default `Asia/Kolkata`). Any further request that day, for any client, is served from the database, so each stock costs at most one provider call per section per day.

| Section | Contents |
|---|---|
| `profile` | Quote, market cap, P/E, industry P/E, P/B, ROE, ROCE, debt/equity, growth, pros/cons |
| `financials` | Quarterly P&L; annual P&L, balance sheet, cash flow, ratios (latest periods) |
| `shareholding` | Quarterly promoter / FII / DII / public holding |
| `pledge` | Promoter pledge history and events |

**Query parameters**

| Name | Type | Default | Notes |
|---|---|---|---|
| `sections` | comma list | all four | e.g. `profile,pledge`. Unknown names → `400`. |

There is deliberately no way to force a second provider call on the same day.

**Response `200`**

```json
{
  "stock": { "id": 1, "name": "State Bank of India", "isin": "INE062A01020", "symbol": "SBIN" },
  "provider": "tapetide",
  "fund_signal": {
    "funds_holding": 199,
    "rank": 5,
    "weight_avg": 3.4487862311557786,
    "weight_min": 0.000299,
    "weight_max": 17.551739,
    "categories": [
      { "category": "Large Cap", "funds_holding": 33, "funds_in_category": 35, "weight_avg": 3.3351249393939395 },
      { "category": "Small Cap", "funds_holding": 3, "funds_in_category": 36, "weight_avg": 1.4733333333333334 }
    ]
  },
  "fundamentals": {
    "profile": {
      "data": { "...": "provider payload, passed through as returned by Tapetide" },
      "fetched_at": "2026-10-28 03:40:12",
      "provider": "tapetide",
      "cached": false,
      "stale": false
    }
  },
  "cache_policy": { "rule": "one provider call per stock per section per calendar day", "timezone": "Asia/Kolkata", "today": "2026-10-28" },
  "errors": []
}
```

| Field | Meaning |
|---|---|
| `stock.symbol` | NSE symbol, resolved from the ISIN on first use and stored |
| `fund_signal` | Overall consensus plus, per category, how many of that category's funds hold the stock |
| `fundamentals.<section>.data` | The provider's payload for that section, unmodified. Its exact shape is defined by Tapetide. |
| `fetched_at` | When the stored copy was fetched (UTC) |
| `cached` | `true` if served from SQLite without calling the provider (it was already fetched today) |
| `stale` | `true` if today's provider call failed and an older stored copy (from a previous day) was returned |
| `errors` | Per-section problems: `{ section, code, message, retry_after_seconds? }` |

**Partial failure** still returns `200`: sections that could not be fetched are left out (or returned `stale` from storage) and listed in `errors`. A failed call does not count as today's fetch, so the next request tries again. Error codes:

| `code` | Meaning |
|---|---|
| `not_configured` | `TAPETIDE_TOKEN` is not set (only cached data can be served) |
| `auth_failed` | Token rejected |
| `rate_limited` | Daily quota or burst limit reached; see `retry_after_seconds` |
| `symbol_not_found` | No Tapetide symbol matched the stock's ISIN or name |
| `tool_error` | Tapetide returned an error for that section |

Example with no token configured (real response):

```json
{
  "stock": { "id": 1, "name": "State Bank of India", "isin": "INE062A01020", "symbol": null },
  "provider": "tapetide",
  "fund_signal": { "funds_holding": 199, "rank": 5, "...": "..." },
  "fundamentals": {},
  "errors": [
    { "section": "profile", "code": "not_configured", "message": "Tapetide token is not configured (set TAPETIDE_TOKEN)" }
  ]
}
```

Other statuses: `404` unknown stock, `400` unknown section, `503` fundamentals disabled (`fundamentals.enabled: false`).

**Quota:** a stock's first fetch costs about 5 Tapetide calls (symbol lookup plus 4 sections); later days cost 4 (the symbol is stored). Repeat views on the same day cost none.

```sh
curl 'http://localhost:5100/api/stocks/1/fundamentals'
curl 'http://localhost:5100/api/stocks/1/fundamentals?sections=profile,pledge'
```

---

### `GET /stocks/:id/analysis`

AI decision support for one stock. Combines the fund signal with the stock's fundamentals (fetching them on demand if needed) and asks the configured LLM for a verdict. **Lazy and cached:** the model runs only when requested, and the result is reused until its inputs change (new fundamentals, a new scrape, a different model or prompt version).

**Query parameters**

| Name | Type | Default | Notes |
|---|---|---|---|
| `held` | boolean | `false` | `false`: you don't own it → verdict is `BUY` or `IGNORE`. `true`: you own it → `HOLD` or `SELL`. Cached separately. |
| `refresh` | boolean | `false` | `true` re-runs the model even if inputs are unchanged |

**Response `200`** (illustrative values)

```json
{
  "stock": { "id": 419, "name": "KARUR VYSYA BANK LTD.", "isin": "INE036D01028", "symbol": "KARURVYSYA" },
  "held": false,
  "analysis": {
    "verdict": "BUY",
    "confidence": "medium",
    "summary": "Widely held by small-cap funds with steady profit growth and a valuation below its sector.",
    "fund_consensus": "Held by 22 of 36 tracked small-cap funds at about 2% average weight.",
    "valuation": "P/E is below the industry P/E in the data provided.",
    "strengths": ["Broad fund-manager backing", "No promoter pledge"],
    "risks": ["Small-cap price volatility"],
    "red_flags": [],
    "what_would_change_view": ["Several funds exiting in the next disclosure"],
    "data_gaps": ["Shareholding data is stale"]
  },
  "model": { "provider": "openrouter", "model": "google/gemini-2.5-flash" },
  "generated_at": "2026-10-28 03:45:10",
  "cached": false,
  "inputs": {
    "fund_signal": { "funds_holding": 22, "...": "..." },
    "fundamentals_sections": ["profile", "financials", "shareholding", "pledge"],
    "stale_sections": ["shareholding"]
  },
  "errors": [],
  "disclaimer": "Decision support generated by an AI model from public data. Not investment advice."
}
```

| Field | Meaning |
|---|---|
| `analysis.verdict` | `BUY` / `IGNORE` (`held=false`) or `HOLD` / `SELL` (`held=true`) |
| `analysis.confidence` | `low` / `medium` / `high`; the model is told to lower it when data is missing or stale |
| `analysis.*` lists | Short sentences; the model is told to cite only numbers present in the data |
| `cached` | `true` if the stored analysis was reused |
| `inputs` | What the model saw: fund signal, which fundamentals sections were available, which were stale |
| `errors` | Fundamentals problems (e.g. no Tapetide token). The analysis still runs on the fund signal alone. |

**Errors**

| Status | `code` | When |
|---|---|---|
| `404` | — | Unknown stock |
| `503` | `not_configured` | LLM key or model missing, or key rejected by the provider |
| `429` | `rate_limited` | The LLM provider rate-limited the request |
| `502` | `request_failed`, `bad_output`, `unreachable` | Provider error, unusable output (e.g. a verdict outside the allowed set), or local server not reachable |

Real response without an LLM key:

```json
{ "error": "LLM API key is not set for https://openrouter.ai/api/v1 (e.g. OPENROUTER_API_KEY)", "code": "not_configured" }
```

**LLM configuration** (`config/app.json` → `ai`; any OpenAI-compatible endpoint):

| Setup | `base_url` | `api_key_env` | `model` example |
|---|---|---|---|
| OpenRouter (default) | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `google/gemini-2.5-flash` |
| LM Studio | `http://127.0.0.1:1234/v1` | — | id of the loaded model |
| Ollama | `http://127.0.0.1:11434/v1` | — | `gemma3:27b` |

```sh
curl 'http://localhost:5100/api/stocks/419/analysis'
curl 'http://localhost:5100/api/stocks/419/analysis?held=true'
```

---

### `GET /stocks/:id/metrics`

Metrics scraped from the stock's own web page during a scrape (price, ratios, financials, shareholding, peers). Only HTML sources (Groww) provide these. With the default source, `metrics` is `null`; use [`/fundamentals`](#get-stocksidfundamentals) instead.

**Response `200`**

```json
{
  "stock_id": 1,
  "name": "State Bank of India",
  "stock_url": null,
  "metrics": null,
  "provenance": null,
  "page_title": null,
  "updated_at": null
}
```

With an HTML source, `metrics` is an object of metric groups (e.g. `valuation_and_fundamental_ratios.pe_ratio`), and `provenance` records per metric which extraction strategy produced the value. `404` for an unknown stock.

---

## Funds & categories

### `GET /funds`

Every tracked fund.

**Response `200`**

```json
[
  {
    "id": 466,
    "name": "360 ONE Flexicap Fund",
    "url": "https://cdn.jsdelivr.net/gh/kushagra-agarwal-a/fund-holdings-data/portfolios/151796",
    "category": "Flexi Cap",
    "last_scraped_at": "2026-10-27 15:56:33"
  }
]
```

`url` is the fund's stable identity for the source; for the default source it identifies the portfolio in the disclosures dataset.

### `GET /categories`

Distinct categories of funds currently in the database (for the leaderboard filter).

```json
["ELSS", "Flexi Cap", "Large Cap", "Mid Cap", "Small Cap", "Thematic", "Value Oriented"]
```

### `GET /categories/:category/changes`

Stocks that entered or left a category in the **most recent run that changed this category**, compared with the run before it. `removed` is the **sell signal**: no tracked fund in that category holds the stock any more.

**Path parameter:** `category`, URL-encoded and case-sensitive (e.g. `Small%20Cap`).

**Response `200`**

```json
{
  "category": "Small Cap",
  "run_id": 1,
  "run_at": "2026-10-27 15:56:35",
  "removed": [],
  "added": [
    { "stock_id": 23, "name": "360 ONE WAM LIMITED" },
    { "stock_id": 359, "name": "3M India Limited" }
  ]
}
```

- On the **first** run every stock appears in `added`; meaningful changes start from the second run.
- Runs where nothing changed for the category are skipped, so the response keeps showing the last real change. Compare `run_at` with the latest job's `finished_at` to tell whether it is current.
- An unknown category is not a `404`; it returns `run_id: null`, `run_at: null` and empty lists.

---

## Scrape jobs

A scrape discovers the funds in each configured category, loads their latest holdings, recomputes the rankings and detects category changes. With the default source (official AMC disclosures) a full run of about 470 funds takes 1–2 minutes and needs no browser. It also runs on the schedule in `config/app.json` → `scrape_cron`.

### `POST /jobs/scrape`

Starts a scrape in the background and returns immediately.

**Response `202`**

```json
{
  "id": 2,
  "status": "running",
  "stage": "discovering_funds",
  "funds_found": null,
  "stocks": null,
  "result": null,
  "error": null,
  "created_at": "2026-10-28 03:29:17",
  "started_at": "2026-10-28 03:29:17",
  "finished_at": null
}
```

**`409`** if a job is already running:

```json
{ "error": "A scrape job is already running (job #2)" }
```

### `GET /jobs/:id`

Poll one job until `status` is `completed` or `failed`.

```json
{
  "id": 1,
  "status": "completed",
  "stage": "completed",
  "funds_found": 476,
  "stocks": 1292,
  "result": {
    "funds": 476,
    "stocks": 1292,
    "stock_metrics": 0,
    "changes": { "added": 4745, "removed": 0 }
  },
  "error": null,
  "created_at": "2026-10-27 15:55:02",
  "started_at": "2026-10-27 15:55:02",
  "finished_at": "2026-10-27 15:56:35"
}
```

| Field | Values |
|---|---|
| `status` | `queued` → `running` → `completed` \| `failed` |
| `stage` | `discovering_funds` → `scraping_holdings` → `aggregating` → `detecting_changes` → `completed` (or `failed`) |
| `result` | Counts when completed; `changes` totals the per-category added/removed stocks |
| `error` | Failure message when `status` is `failed` |

`404` for an unknown id:

```json
{ "error": "Scrape job #999 not found" }
```

### `GET /jobs`

Most recent jobs first. `limit`: 1–100, default `20`. Returns an array of job objects as above.

---

## Diagnostics

### `GET /scrape/dry-run`

Read-only sample: one category → one fund → up to `limit` holdings with every parsed field. Nothing is written to the database. Useful for checking a source or config change in seconds.

| Name | Type | Default | Notes |
|---|---|---|---|
| `category` | name or index | first category | Unknown name → `400` listing the valid ones |
| `fund` | index or name substring | `0` | Which discovered fund to sample |
| `limit` | integer | `5` | 1–50 holdings |

**Response `200`** (default source)

```json
{
  "category": { "name": "Small Cap", "url": "https://cdn.jsdelivr.net/gh/kushagra-agarwal-a/fund-holdings-data/catalog?sub=Small%20Cap%20Fund" },
  "fund": { "name": "Quant Small Cap Fund", "url": "https://cdn.jsdelivr.net/gh/kushagra-agarwal-a/fund-holdings-data/portfolios/100176", "index": 0 },
  "limit": 2,
  "funds_found": 36,
  "holdings_found": 104,
  "holdings": [
    {
      "name": "HFCL Limited",
      "sector": "Telecom - Services",
      "instrument": "equity",
      "weightPercentage": 6.100426,
      "url": null,
      "isin": "INE548A01028",
      "quantity": 95588251,
      "marketValueCr": 2170.0445,
      "asOf": "2026-09-30",
      "metrics": null
    }
  ],
  "diagnostics": ["Showing the first 2 of 104 parsed holding(s)."]
}
```

`asOf` is the disclosure date; `marketValueCr` is in ₹ crore; `weightPercentage` is % of the fund's NAV.

### `GET /scrape/categories`

Category names configured in `config/scraping.json`, in config order (what the dry run can sample).

```json
["Large Cap", "Mid Cap", "Small Cap", "ELSS", "Thematic", "Value Oriented", "Flexi Cap"]
```

---

## Typical flows

**Populate data**

1. `POST /jobs/scrape` → note `id`.
2. Poll `GET /jobs/:id` until `completed`.

**Browse**

1. `GET /categories` → fill the category filter.
2. `GET /stocks/leaderboard?category=Small%20Cap&limit=20`.
3. `GET /categories/Small%20Cap/changes` → alert on `removed` stocks you hold.

**Stock detail** (client route `/stock/:stockId`)

1. `GET /stocks/:id` → stored scrape data (holding funds, category coverage, changes). Instant, no external calls.
2. On the user's request: `GET /stocks/:id/fundamentals` → ratios, financials, shareholding, pledge (provider called at most once per stock per day).
3. Optionally: `GET /stocks/:id/analysis?held=true|false` → AI verdict with reasons.
