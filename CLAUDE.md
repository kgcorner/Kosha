# CLAUDE.md — working context for Kosha

Read this before changing anything in this repo. It summarises the architecture, conventions and known gotchas. The authoritative references are `backend/docs/API.md`, `backend/docs/FEATURES.md`, `backend/requirements.md` (original design, partly outdated) and `client/docs/CLIENT_REQUIREMENTS.md`.

## What the project is

Kosha ranks Indian stocks by how many actively managed mutual funds hold them (consensus), tracks category changes as sell signals, and adds on-demand fundamentals and an LLM verdict (BUY/IGNORE, or HOLD/SELL with `held=true`). Single developer. Repo: `kgcorner/Kosha` (public).

## Layout

- `backend/` — Node 20+, ESM (`"type": "module"`), Express, `better-sqlite3`, `node-cron`, `playwright` (only for browser-based sources). Tests use `node --test` (`npm test`).
  - `src/server.js` — entry. Loads `.env` first (`env.js` must stay the first import), builds services, starts Express and cron.
  - `src/app.js` — Express app and error mapping (message prefixes → 400/409/500).
  - `src/config.js` — loads `config/app.json` and the scraping config; env overrides `APP_CONFIG`, `SCRAPING_CONFIG`, `PORT`, `DATABASE_PATH`.
  - `src/routes/api.js` — all `/api` routes.
  - `src/scrapers/` — `sourceAdapter.js` (interface), `sourceRegistry.js` (registers `fund-disclosures`, `mfdata`, `groww`, `moneycontrol`), `fundDisclosuresAdapter.js` (default), `mutualFundScraper.js`, `stockScraper.js`, `browser.js`, `xpath.js`, `stockMetrics.js`.
  - `src/services/` — `scrapeJob.js` (pipeline + job state), `aggregationService.js` (consensus + category changes), `stockAnalysisService.js` (LLM verdict, prompt `PROMPT_VERSION`, JSON schema, digest builder), `llmProviders.js` (OpenAI-compatible client), `fundamentalsService.js` + `tapetideClient.js` (cached, budgeted fundamentals), `marketMath.js` (price-history statistics), `scrapeDryRun.js`, `ollamaService.js` (scrape-time thesis).
  - `src/db/database.js` — schema creation, migrations (`ensureColumn`), `backfillWeightStats()`. `repositories.js` — all SQL access.
- `client/` — Angular 22, standalone components, signals, `ng serve` on the Angular default port with `proxy.conf.json` forwarding `/api` to `localhost:5100`.
  - Routes: `leaderboard`, `stock/:stockId`, `signals`, `funds`, `jobs`, `**` (not found). Root redirects to leaderboard.
  - `src/app/core/` — `api.ts` (HTTP client, all endpoints), models in `core/models/`, `sell-signals.ts` (followed categories in localStorage key `kosha.followedCategories`), `job-monitor.ts`, `data-refresh.ts`, `categories.ts`, `excluded-names.ts`, formatters.
  - `src/app/shared/` — `data-view`, `charts` (column and line).

## Data model (SQLite)

Tables: `funds`, `stocks` (keyed by ISIN for fund-disclosures data), `fund_holdings`, `stock_aggregations` (consensus, weight_avg/min/max, rank, AI thesis/pros/cons), `stock_metrics`, `stock_fundamentals`, `stock_analyses`, `market_data`, `scrape_jobs`, `category_stocks` (baseline), `category_change_runs`, `category_stock_changes`.

- Holdings are replaced per fund in one transaction (delete then insert, de-duplicated).
- Display weights are per-fund averages (`weight_avg`, `weight_min`, `weight_max`). Never show or rank by a summed weight as a meaningful figure; `total_weight_sum` is internal only.
- A stock's `last_analyzed_at` resets when its score or weight changes, so AI re-enrichment picks it up.

## Pipeline (one scrape)

1. Discover funds per category → upsert `funds`.
2. Read holdings per fund → replace `fund_holdings`.
3. Scrape stock pages for unique stocks (only if the source has them; capped by `scrape.stock_limit`).
4. Recompute aggregations (global and per category).
5. Detect category changes against `category_stocks`; removals are sell signals.

Only one scrape runs at a time (second trigger → 409). A job left `running` is marked `failed` on startup (`reapStale`). The cron (`scrape_cron`, default `0 6 * * *`) validates at startup and fails fast if invalid.

## Lazy, budgeted external calls

- **Fundamentals (Tapetide):** called at most once per stock per section per day (timezone `Asia/Kolkata`). Free plan ≈ 50 calls/day. First fetch ≈ 7 calls, later days ≈ 6. Stored responses are served on failure with `stale: true`. Never called by the scrape job.
- **Market data:** at most once per day in total.
- **AI verdict:** cached per stock and per `held` flag until inputs change (fundamentals, scrape). `refresh=true` forces a new run. Bump `PROMPT_VERSION` in `stockAnalysisService.js` when the prompt or schema changes, so the cache invalidates correctly.

Keep these budgets in mind when adding any endpoint that touches Tapetide or the LLM.

## Conventions

- Secrets come from the environment only (`TAPETIDE_TOKEN`, `OPENROUTER_API_KEY`, or the variable named in `*_env` config fields). Never put keys in `config/*.json`. `backend/.env` is git-ignored.
- Config paths are relative to `backend/`.
- Error mapping in `app.js` depends on message prefixes ("A scrape job is already running", "Pagination…", "Unknown dry-run category", "Unknown fundamentals section"). Keep the prefixes if you change those messages, or update the mapping.
- XPath reads are bounded and tolerant. A detached element resolves to null and must not crash a job.
- Add a new source by implementing `SourceAdapter` and registering it. Don't branch on source names elsewhere.
- Tests live in `backend/test/` and mirror service/scraper names. Run `npm test` in `backend/`. Client specs are `*.spec.ts` (`ng test`).

## Known gotchas (verified against the code and docs)

- **Port mismatch.** `config/app.json` and `client/proxy.conf.json` use **5100**. `backend/docs/API.md`, `FEATURES.md` and `requirements.md` still show **3300**. Trust the config.
- **Database path mismatch.** `config/app.json` points to `./data/kosha-amc.sqlite`. Older docs say `data/stocks.sqlite`. The file `backend/data/kosha-amc.sqlite` is **tracked in git** even though `*.sqlite` is git-ignored (force-added). Be careful not to commit a changed copy by accident.
- **Root `.gitignore`** mentions a `kosha/` folder, but the Angular app is in `client/`. Its rules still apply by glob.
- **`requirements.md`** describes the original Groww-only design (Playwright, `node-cron`, weights null). The current default source is `fund-disclosures`, which has real weights and ISINs and needs no browser.
- **Groww** exposes names only in the old design, but the Groww adapter now reads weights and stock links. Check `FEATURES.md` §1.2 before relying on either description.
- **MFData** source is documented as unreliable.
- **Disclosures lag** about two weeks after month-end. Data can be 4–6 weeks old. Keep this in any user-facing wording.
- **Scrape runs in-process.** Running the API on two instances would run two cron schedules.

## Before you change things

- Read the relevant doc in `backend/docs/` or `client/docs/` first, then the code.
- Check `git status` and don't commit unless asked. Use the attribution lines given in the session when committing or opening PRs.
- Keep the README in step with real behaviour. Update `backend/docs/API.md` when you change an endpoint.
- When changing the AI prompt or schema, bump `PROMPT_VERSION` and run the analysis tests.
- When changing aggregation, check both the global and per-category paths, and the category change detection.
