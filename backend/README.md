# Stock Recommender Backend

Node.js API and scheduled scraper for Indian mutual-fund holdings and cross-fund stock aggregation.

**API reference (every endpoint, parameters, responses, errors): [`docs/API.md`](docs/API.md).** Feature overview and configuration: [`docs/FEATURES.md`](docs/FEATURES.md).

## Setup

Requires Node.js 20 or later. From this directory:

```sh
npm install
npx playwright install chromium
npm start
```

The SQLite database is created at `data/stocks.sqlite` by default.

## Configuration

- `config/scraping.json` configures the fund categories, the source adapter (`source`, now `fund-disclosures` by default), XPath selectors (Groww/Moneycontrol only), browser timeouts, and an optional fund limit. Each category may carry its own `xpath`, falling back to `selectors.mf_list_page.fund_row`.
- `config/app.json` configures the API port, SQLite path, cron expression, and the LLM provider (`llm`, OpenAI-compatible), Tapetide fundamentals (`fundamentals`) and the optional scrape-time thesis (`ai`).
- Set `APP_CONFIG`, `SCRAPING_CONFIG`, `PORT`, or `DATABASE_PATH` to override defaults. Config paths are relative to `backend/`.
- Groww's holdings table (`Name | Sector | Instruments | Assets`) is read row-by-row, so portfolio **weights are captured** (`weight_percentage` from the Assets column) and each row's **stock detail URL** (`stock_url`, the company cell's `//a/@href`) is stored. The leaderboard ranks by consensus (distinct funds) then summed weight internally, but **displays the per-fund average weight with its min–max range** (`weight_avg` / `weight_min` / `weight_max`) — summing one stock's weight across dozens of funds is not a meaningful figure.
- Each stock's own detail page is then visited once and every metric under `selectors.stock_page.metrics` (price, valuation ratios, financial trends, shareholding, corporate actions, filings, peers) is persisted to `stock_metrics`; `selectors.stock_page.hints` provides XPath/label/`__NEXT_DATA__`-payload fallbacks for Groww's moving markup, and `scrape.stock_limit` optionally caps how many stock pages a run visits.

### AI analysis (on demand, OpenAI-compatible)

`GET /api/stocks/:id/analysis` sends Kosha's fund signal plus the stock's fundamentals to an LLM and returns a verdict: **BUY / IGNORE** by default, or **HOLD / SELL** with `?held=true`. The response includes confidence, a summary, fund consensus, valuation, strengths, risks, red flags, what would change the view, and data gaps. Results are cached per stock (and per held flag) until the inputs change (new fundamentals or a new scrape); `?refresh=true` forces a new run.

Any OpenAI-compatible endpoint works; configure `llm` in `config/app.json`:

| Setup | `base_url` | `api_key_env` | `model` example |
|---|---|---|---|
| OpenRouter (default) | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `google/gemini-2.5-flash` |
| LM Studio (local) | `http://127.0.0.1:1234/v1` | — | the loaded model's id |
| Ollama (local) | `http://127.0.0.1:11434/v1` | — | `gemma3:27b` |

Keys are read from the environment only. Strict JSON-schema output is used when the model supports it, with automatic fallback to JSON mode for models that don't. The optional scrape-time thesis (`ai.enabled`) uses the same provider.

### Fundamentals (Tapetide, on demand)

Set `TAPETIDE_TOKEN` (personal token from https://tapetide.com/settings/tokens) before `npm start`. The token is read from the environment only; never put it in a config file. Without it the endpoint serves cached data only. Stocks are matched to Tapetide symbols by ISIN (cached in `stocks.symbol`). A first view of a stock costs ~5 calls (symbol search + 4 sections); repeat views within the TTL cost nothing. The free plan allows 50 calls/day.

### Default source: AMC disclosures (`fund-disclosures`)

`config/scraping.json` uses `src/scrapers/fundDisclosuresAdapter.js`, which reads the **official AMC monthly portfolio disclosures** as parsed and published by the open [fund-disclosures](https://github.com/subscriptionmanager26-png/fund-disclosures) project (data repo `kushagra-agarwal-a/fund-holdings-data`). No API key, no browser.

- Each category `url` lists AMFI sub-categories via `?sub=` (e.g. `sub=Small%20Cap%20Fund`, or `sub=Value%20Fund&sub=Contra%20Fund`). Matching is exact, so "Large & Mid Cap Fund" never leaks into Mid Cap.
- One fund per portfolio (Direct/Regular/IDCW share one book); index funds/ETFs/FoFs are excluded (`fund_disclosures.exclude_name_pattern`).
- Holdings carry ISIN, industry, weight (% of NAV), quantity and market value. **Stocks are keyed by ISIN**, because AMCs spell the same company several ways ("Ltd." / "Limited" / "EQ - …").
- Latest monthly filing by default; set `fund_disclosures.as_of` (`YYYY-MM-DD` month-end) to pin a month. Data typically lands ~2 weeks after month-end.
- Files come from jsDelivr with automatic fallback to GitHub raw (`fund_disclosures.mirror: "raw"` forces raw).
- API sources set `requiresBrowser = false`, so no Chromium is launched for them.

Other sources: `config/scraping.groww.json` (Groww HTML scraping) and `config/scraping.mfdata.json` (MFData.in API — currently unreliable). Switch with `SCRAPING_CONFIG=config/scraping.groww.json npm start`.

To add a source, implement `SourceAdapter` in `src/scrapers/sourceAdapter.js`, implement `supports(url)` and the scraping methods (`discoverFunds`, `scrapeFundHoldings`), and register its factory in `src/scrapers/sourceRegistry.js` (`fund-disclosures`, `mfdata`, `groww` and `moneycontrol` are registered; `scraping.json` selects which one via `source`). XPath reads are bounded and tolerant of SPA re-render races, so a missing element never crashes a scrape job.

## API (summary)

- `GET /api/stocks/leaderboard?limit=20&offset=0&category=Small%20Cap` — consensus ranking with AI thesis/pros/cons, the stock's `stock_url` and its scraped `metrics`; `category` scopes the ranking to that category's funds (and each row carries a `categories` list).
- `GET /api/stocks/:id/metrics` — the full metric set scraped from one stock's detail page (price, ratios, financials, shareholding, peers) plus per-metric `provenance`; `404` if the stock is unknown.
- `GET /api/stocks/:id/fundamentals?refresh=false&sections=profile,financials,shareholding,pledge` — **lazy** fundamentals from Tapetide (quote + valuation ratios, financial statements, quarterly shareholding, promoter pledge) plus Kosha's `fund_signal` (funds holding it, overall and per category). Never called by the scrape job; each section is cached in `stock_fundamentals` (profile 24h, the rest 30 days — `fundamentals.ttl_hours` in `config/app.json`). When the provider fails or the quota is used up, the last cached copy is returned with `stale: true` and an `errors` entry.
- `GET /api/stocks/:id/analysis?held=false&refresh=false` — **lazy** LLM verdict (BUY/IGNORE, or HOLD/SELL when `held=true`) from fund signal + fundamentals; cached until inputs change. 503 when no LLM is configured, 429 when rate-limited, 502 on model errors.
- `GET /api/funds` — tracked funds and their last scrape timestamp.
- `GET /api/categories` — distinct fund categories (leaderboard filter options).
- `GET /api/scrape/dry-run?category=Small%20Cap&fund=0&limit=5` — read-only selector heat-and-trial: one category → one fund → up to 5 holdings with every parsed data point (name, sector, instrument, weight, stock URL) **and each holding's scraped stock-page metrics** plus diagnostics.
- `GET /api/scrape/categories` — categories a dry run can sample.
- `POST /api/jobs/scrape` — start a scrape in the background (`202` + job record; `409` if one is already running).
- `GET /api/jobs/:id` / `GET /api/jobs?limit=20` — poll / list scrape jobs.
- `GET /api/categories/:category/changes` — stocks added/removed in a category since the previous run; `removed` is the sell signal.

Run `GET /api/scrape/dry-run` while tuning `config/scraping.json` — it never writes to the database, so it is safe to call repeatedly.

See [`docs/FEATURES.md`](docs/FEATURES.md) for full payloads. The scheduled job runs on `scrape_cron` (daily at 06:00 by default); AI enrichment is off until `ai.enabled` is `true`.
