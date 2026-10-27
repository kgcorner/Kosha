# Stock Recommender Backend

Node.js API and scheduled scraper for Indian mutual-fund holdings and cross-fund stock aggregation.

**Full feature & API reference with request/response payloads: [`docs/FEATURES.md`](docs/FEATURES.md).**

## Setup

Requires Node.js 20 or later. From this directory:

```sh
npm install
npx playwright install chromium
npm start
```

The SQLite database is created at `data/stocks.sqlite` by default.

## Configuration

- `config/scraping.json` configures the fund categories, the source adapter (`source`, now `mfdata` by default), XPath selectors (Groww/Moneycontrol only), browser timeouts, and an optional fund limit. Each category may carry its own `xpath`, falling back to `selectors.mf_list_page.fund_row`.
- `config/app.json` configures the API port, SQLite path, cron expression, and optional Ollama analysis.
- Set `APP_CONFIG`, `SCRAPING_CONFIG`, `PORT`, or `DATABASE_PATH` to override defaults. Config paths are relative to `backend/`.
- Groww's holdings table (`Name | Sector | Instruments | Assets`) is read row-by-row, so portfolio **weights are captured** (`weight_percentage` from the Assets column) and each row's **stock detail URL** (`stock_url`, the company cell's `//a/@href`) is stored. The leaderboard ranks by consensus (distinct funds) then summed weight internally, but **displays the per-fund average weight with its min–max range** (`weight_avg` / `weight_min` / `weight_max`) — summing one stock's weight across dozens of funds is not a meaningful figure.
- Each stock's own detail page is then visited once and every metric under `selectors.stock_page.metrics` (price, valuation ratios, financial trends, shareholding, corporate actions, filings, peers) is persisted to `stock_metrics`; `selectors.stock_page.hints` provides XPath/label/`__NEXT_DATA__`-payload fallbacks for Groww's moving markup, and `scrape.stock_limit` optionally caps how many stock pages a run visits.

### MFData.in API source (`mfdata`)

`src/scrapers/mfdataAdapter.js` reads from the free [MFData.in](https://mfdata.in/docs) REST API instead of scraping HTML. It is the default: `config/scraping.json` sets `"source": "mfdata"` with `homepage_url` `https://mfdata.in/`, and every category URL points at `mfdata.in`, so `supports(url)` resolves them to this adapter. The previous Groww config is kept at `config/scraping.groww.json` — run `SCRAPING_CONFIG=config/scraping.groww.json npm start` to switch back.

- Each category `url` is a schemes query (`/api/v1/schemes?category=Small%20Cap&plan_type=direct`). Plan variants are collapsed to one fund per scheme family, and index funds/ETFs/FoFs are dropped (`mfdata.exclude_name_pattern`).
- Holdings come from `/api/v1/families/{id}/holdings?holding_type=equity`; set `mfdata.month` (`YYYY-MM`) to pin a disclosure month, otherwise the latest is used.
- Holdings carry weight, sector, ISIN, quantity and market value but **no stock URL**, so the per-stock metrics pass is skipped for this source (fundamentals need a separate provider).
- Requests are throttled (`request_delay_ms`) and retried on 429/5xx, honouring `Retry-After`.

To add a source, implement `SourceAdapter` in `src/scrapers/sourceAdapter.js`, implement `supports(url)` and the scraping methods (`discoverFunds`, `scrapeFundHoldings`), and register its factory in `src/scrapers/sourceRegistry.js` (`mfdata`, `groww` and `moneycontrol` are registered; `scraping.json` selects which one via `source`). XPath reads are bounded and tolerant of SPA re-render races, so a missing element never crashes a scrape job.

## API (summary)

- `GET /api/stocks/leaderboard?limit=20&offset=0&category=Small%20Cap` — consensus ranking with AI thesis/pros/cons, the stock's `stock_url` and its scraped `metrics`; `category` scopes the ranking to that category's funds (and each row carries a `categories` list).
- `GET /api/stocks/:id/metrics` — the full metric set scraped from one stock's detail page (price, ratios, financials, shareholding, peers) plus per-metric `provenance`; `404` if the stock is unknown.
- `GET /api/funds` — tracked funds and their last scrape timestamp.
- `GET /api/categories` — distinct fund categories (leaderboard filter options).
- `GET /api/scrape/dry-run?category=Small%20Cap&fund=0&limit=5` — read-only selector heat-and-trial: one category → one fund → up to 5 holdings with every parsed data point (name, sector, instrument, weight, stock URL) **and each holding's scraped stock-page metrics** plus diagnostics.
- `GET /api/scrape/categories` — categories a dry run can sample.
- `POST /api/jobs/scrape` — start a scrape in the background (`202` + job record; `409` if one is already running).
- `GET /api/jobs/:id` / `GET /api/jobs?limit=20` — poll / list scrape jobs.
- `GET /api/categories/:category/changes` — stocks added/removed in a category since the previous run; `removed` is the sell signal.

Run `GET /api/scrape/dry-run` while tuning `config/scraping.json` — it never writes to the database, so it is safe to call repeatedly.

See [`docs/FEATURES.md`](docs/FEATURES.md) for full payloads. The scheduled job runs on `scrape_cron` (daily at 06:00 by default); AI enrichment is off until `ai.enabled` is `true`.
