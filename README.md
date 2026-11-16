# Kosha

Kosha is a stock-analysis tool for the Indian market. It reads the monthly portfolio disclosures of actively managed mutual funds, works out which stocks many funds hold together, and shows that consensus in a web app. Each stock can also get an on-demand AI verdict and fundamentals from a third-party data provider.

Kosha is a research aid, not investment advice.

## What it does

- **Consensus leaderboard.** Ranks stocks by how many tracked funds hold them, with the average per-fund allocation and its min–max range. Can be scoped to one SEBI fund category.
- **Sell signals.** Records when a stock leaves a category's holdings between scrape runs. A removal is the signal.
- **Stock detail.** Shows the funds holding a stock, its category coverage, scraped market metrics, and lazily loaded fundamentals.
- **AI verdict (on demand).** Returns BUY / IGNORE for a stock you don't hold, or HOLD / SELL when you do (`?held=true`). Results are cached until the inputs change.
- **Scrape jobs.** Runs the full pipeline in the background on a daily cron (06:00 by default) or on demand, with progress polling.
- **Funds page.** Lists the tracked funds and when each was last refreshed.

## Repository layout

```
backend/    Node.js (Express) API, scrapers, SQLite storage, LLM and fundamentals clients
  config/   app.json, scraping*.json (sources, categories, selectors, AI, fundamentals)
  src/      server.js (entry), app.js (Express app), routes/, services/, scrapers/, db/
  test/     node:test suites
  docs/     API.md (endpoint reference), FEATURES.md (feature and payload reference)
client/     Angular single-page app (standalone components, signals)
  src/app/  features/ (leaderboard, stock-detail, sell-signals, funds, jobs), core/, shared/
  docs/     CLIENT_REQUIREMENTS.md
```

## How data flows

1. **Discover funds.** The configured source (default: `fund-disclosures`) lists funds for each category and upserts them into `funds`.
2. **Read holdings.** Each fund's latest monthly portfolio is stored in `fund_holdings`, replacing the previous snapshot in one transaction. Stocks are keyed by ISIN.
3. **Enrich stocks.** Scraped metrics for each unique stock go to `stock_metrics`. Only sources that expose stock pages provide these.
4. **Aggregate.** SQL computes consensus score, per-fund weight statistics and rank in `stock_aggregations`, both globally and per category.
5. **Detect changes.** Compares each category's current stock set with the stored baseline and records added and removed stocks.
6. **Serve.** The Angular client reads the REST API. Fundamentals and AI verdicts are fetched only when requested and then cached.

## Prerequisites

- Node.js 20 or later
- npm
- Optional: Chromium via Playwright, only for browser-based sources (`groww`, `moneycontrol`). The default source does not need a browser.

## Setup

### Backend

```sh
cd backend
npm install
cp .env.example .env        # then fill in your keys (optional, see below)
npm start                   # API on the port in config/app.json (5100)
```

Optional, only for browser-based sources:

```sh
npx playwright install chromium
```

Run the tests:

```sh
npm test
```

### Client

```sh
cd client
npm install
npm start                   # Angular dev server, proxies /api to http://localhost:5100
```

Open the app at the Angular dev server URL. `client/proxy.conf.json` forwards `/api` to the backend.

## Configuration

Config files live in `backend/config/` and are resolved relative to `backend/`.

| File | Purpose |
|---|---|
| `app.json` | Port, SQLite path, scrape cron, LLM (`ai`) settings, Tapetide fundamentals settings |
| `scraping.json` | Source adapter (`source`), categories and URLs, selectors, `fund_disclosures` options, stock-page limits |
| `scraping.groww.json` | Alternative config for the Groww HTML source |
| `scraping.mfdata.json` | Alternative config for the MFData.in API (currently unreliable) |

Switch configs with environment variables, for example `SCRAPING_CONFIG=config/scraping.groww.json npm start`.

Other overrides: `APP_CONFIG`, `PORT`, `DATABASE_PATH`, `ENV_FILE`.

### Secrets

Keys are read only from the environment, never from config files. Put them in `backend/.env` (git-ignored; copy from `.env.example`). Variables already exported in your shell take precedence.

| Variable | Used for |
|---|---|
| `TAPETIDE_TOKEN` | Stock fundamentals and market data. Without it, only cached data is served. |
| `OPENROUTER_API_KEY` | AI verdicts when the LLM is hosted on OpenRouter (the default). Not needed for local LM Studio or Ollama. |

### AI provider

Any OpenAI-compatible endpoint works. Set `ai.base_url`, `ai.api_key_env` and `ai.model` in `config/app.json`. Examples:

- OpenRouter (default): `https://openrouter.ai/api/v1`, model `google/gemini-2.5-flash`
- LM Studio: `http://127.0.0.1:1234/v1`
- Ollama: `http://127.0.0.1:11434/v1`, for example `gemma3:27b`

The scrape-time thesis is off by default (`ai.scrape_thesis.enabled: false`).

### Fundamentals budget

The Tapetide free plan allows about 50 calls per day. A stock's first fetch costs roughly 7 calls, and later days about 6. Repeat views on the same day cost nothing. Each response is stored, and the provider is called at most once per stock per section per day (IST).

## API summary

Full reference with payloads: [`backend/docs/API.md`](backend/docs/API.md) and [`backend/docs/FEATURES.md`](backend/docs/FEATURES.md).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/stocks/leaderboard` | Ranked consensus list. Params: `limit`, `offset`, `category` |
| GET | `/api/stocks/:id` | Everything stored about one stock. No external calls |
| GET | `/api/stocks/:id/metrics` | Scraped metrics for one stock, with provenance |
| GET | `/api/stocks/:id/fundamentals` | Lazy fundamentals from Tapetide plus fund signal |
| GET | `/api/stocks/:id/analysis` | Lazy AI verdict. Params: `held`, `refresh` |
| GET | `/api/market` | Market-wide FII/DII flows and pulse (cached once a day) |
| GET | `/api/funds` | Tracked funds and last scrape time |
| GET | `/api/categories` | Distinct fund categories |
| GET | `/api/categories/:category/changes` | Latest added and removed stocks (sell signals) |
| GET | `/api/scrape/dry-run` | Read-only selector test, writes nothing |
| GET | `/api/scrape/categories` | Categories the dry run can sample |
| POST | `/api/jobs/scrape` | Start a scrape in the background (`202`; `409` if one is running) |
| GET | `/api/jobs` / `/api/jobs/:id` | List or poll scrape jobs |

Error codes: `400` for bad parameters, `409` for a scrape already running, `429` when the AI provider rate-limits, `502` for model errors, `503` when no LLM is configured.

## Adding a data source

Implement `SourceAdapter` (`backend/src/scrapers/sourceAdapter.js`): `supports(url)`, `discoverFunds(page)`, `scrapeFundHoldings(page, fund)`. Register the factory in `backend/src/scrapers/sourceRegistry.js`, then select it with `source` in a scraping config.

## Notes and limitations

- **Disclosures lag.** AMC monthly disclosures usually appear about two weeks after month-end, so holdings can be four to six weeks old.
- **Consensus is not a recommendation.** Many funds can crowd into the same names.
- **Weights.** Per-fund averages are shown instead of summed weights, because a sum across many funds is not meaningful.
- **One scrape at a time.** A scrape runs inside the API process. A job left `running` after a crash is marked `failed` at startup.
- **Single-user design.** There is no authentication. Followed categories are stored in the browser's localStorage.

## Licence

No licence file is included yet.
