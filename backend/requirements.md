# Backend Requirements & System Design Document: Mutual Fund Stock Aggregator

## 1. Executive Summary
A lightweight Node.js backend using SQLite to automatically scrape Indian mutual-fund portfolios from **Groww** (Mid Cap, Large Cap, Small Cap, ELSS, Thematic, Value Oriented, Flexi Cap), aggregate stock exposure across funds, enrich top-performing consensus stocks using local AI (LLM), and expose a REST API to serve an Angular frontend client.

---

## 2. Tech Stack & System Components
* **Runtime:** Node.js (Latest LTS)
* **Web Framework:** Express.js / Fastify
* **Scraper Engine:** `playwright` or `puppeteer` (required to render dynamic DOM and click "View All" triggers)
* **Database:** SQLite (`better-sqlite3` driver)
* **AI Engine:** Local LLM endpoint (Ollama / Qwen / Gemma)
* **Job Scheduler:** `node-cron`

---

## 3. Database Schema (SQLite)

```sql
-- Mutual Funds Master Table
CREATE TABLE IF NOT EXISTS funds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT UNIQUE NOT NULL,
    category TEXT,
    last_scraped_at DATETIME
);

-- Normalized Stock Master Table
CREATE TABLE IF NOT EXISTS stocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
);

-- Raw Portfolio Holdings per Fund
CREATE TABLE IF NOT EXISTS fund_holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_id INTEGER NOT NULL,
    stock_id INTEGER NOT NULL,
    weight_percentage REAL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(fund_id) REFERENCES funds(id) ON DELETE CASCADE,
    FOREIGN KEY(stock_id) REFERENCES stocks(id) ON DELETE CASCADE,
    UNIQUE(fund_id, stock_id)
);

-- Aggregated Cross-Fund Metrics & AI Thesis
CREATE TABLE IF NOT EXISTS stock_aggregations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_id INTEGER UNIQUE NOT NULL,
    consensus_score INTEGER NOT NULL, -- Number of top funds holding this stock
    total_weight_sum REAL NOT NULL,    -- Raw sum of Assets % across funds (internal ordering only)
    weight_avg REAL,                   -- Average Assets % per holding fund (display value)
    weight_min REAL,                   -- Lowest per-fund Assets %
    weight_max REAL,                   -- Highest per-fund Assets %
    rank INTEGER NOT NULL,
    ai_thesis TEXT,                    -- Short investment summary
    ai_pros TEXT,                      -- JSON array string
    ai_cons TEXT,                      -- JSON array string
    last_analyzed_at DATETIME,
    FOREIGN KEY(stock_id) REFERENCES stocks(id) ON DELETE CASCADE
);

-- Per-category stock membership baseline, compared run-to-run to detect changes.
CREATE TABLE IF NOT EXISTS category_stocks (
    category TEXT NOT NULL,
    stock_id INTEGER NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (category, stock_id),
    FOREIGN KEY(stock_id) REFERENCES stocks(id) ON DELETE CASCADE
);

-- One row per change-detection pass that observed at least one change.
CREATE TABLE IF NOT EXISTS category_change_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Individual added/removed events, grouped by the run that detected them.
CREATE TABLE IF NOT EXISTS category_stock_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    stock_id INTEGER NOT NULL,
    change_type TEXT NOT NULL, -- 'added' | 'removed'
    detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(run_id) REFERENCES category_change_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(stock_id) REFERENCES stocks(id) ON DELETE CASCADE
);
```

---

## 4. Scraping Configuration & Algorithm

### 4.1 Target URLs & Selectors Map

```json
{
  "source": "groww",
  "homepage_url": "https://groww.in/",
  "categories": [
    { "category": "Mid Cap", "url": "https://groww.in/mutual-funds/filter?sub_cat=%5B%22Mid+Cap%22%5D", "xpath": "//a[contains(@class, 'tableCells_srLink__PZHGP')]" },
    { "category": "Large Cap", "url": "https://groww.in/mutual-funds/filter?sub_cat=%5B%22Large+Cap%22%5D", "xpath": "//a[contains(@class, 'tableCells_srLink__PZHGP')]" },
    { "category": "Small Cap", "url": "https://groww.in/mutual-funds/filter?sub_cat=%5B%22Small+Cap%22%5D", "xpath": "//a[contains(@class, 'tableCells_srLink__PZHGP')]" },
    { "category": "ELSS", "url": "https://groww.in/mutual-funds/filter?sub_cat=%5B%22ELSS%22%5D", "xpath": "//a[contains(@class, 'tableCells_srLink__PZHGP')]" },
    { "category": "Thematic", "url": "https://groww.in/mutual-funds/filter?sub_cat=%5B%22Thematic%22%5D", "xpath": "//a[contains(@class, 'tableCells_srLink__PZHGP')]" },
    { "category": "Value Oriented", "url": "https://groww.in/mutual-funds/filter?sub_cat=%5B%22Value+Oriented%22%5D", "xpath": "//a[contains(@class, 'tableCells_srLink__PZHGP')]" },
    { "category": "Flexi Cap", "url": "https://groww.in/mutual-funds/filter?sub_cat=%5B%22Flexi+Cap%22%5D", "xpath": "//a[contains(@class, 'tableCells_srLink__PZHGP')]" }
  ],
  "selectors": {
    "mf_list_page": {
      "fund_row": "//a[contains(@class, 'tableCells_srLink__PZHGP')]"
    },
    "mf_detail_page": {
      "view_all_holdings_button": "",
      "holding_row": "//div[@id='holdingsContainer']//tr[contains(@class, 'holdings_row__go8vY')]//span[contains(@class, 'holdings_link__kjPQ5')]"
    }
  }
}
```

> Groww's listing XPath selects the fund `<a>` node directly — its text is the fund **name** and its `@href` is the fund **link**, so no sub-selectors are needed. Each category carries its own `xpath`; if omitted it falls back to `selectors.mf_list_page.fund_row`. Groww exposes only holding **names** (no weight %, no per-stock link), so `weight_percentage` is stored as `null` and the leaderboard ranks purely by consensus.

### 4.2 Scraping Execution Flow

#### Phase 1: Fund Discovery
1. Launch headless browser (`Playwright`/`Puppeteer`).
2. For each entry in `categories` (Mid Cap, Large Cap, Small Cap, ELSS, Thematic, Value Oriented, Flexi Cap), navigate to its `url` on Groww.
3. Evaluate the category's XPath (its `xpath`, falling back to `selectors.mf_list_page.fund_row`), which matches fund `<a>` nodes.
4. For each node, read its text as `fund_name` and its `@href` as `fund_link` (resolved to an absolute URL).
5. Upsert discovered mutual funds into the `funds` table in SQLite, de-duplicating by `url` and recording each fund's first-seen `category`.

#### Phase 2: Stock Holdings Extraction
1. Iterate over all funds stored in the `funds` table.
2. Navigate to each target `fund_link`.
3. Optionally fire the `view_all_holdings_button` trigger element if configured (empty for Groww by default).
4. Evaluate XPath `selectors.mf_detail_page.holding_row`.
5. Extract properties per row:
   * `stock_name`: Sanitize and trim string (remove whitespace/newlines).
   * `stock_weight`: Groww provides no weight, so it is stored as `null`.
6. Upsert sanitized `stock_name` into `stocks` table to obtain `stock_id`.
7. Clear previous holdings for `fund_id` and batch-insert into `fund_holdings`.
8. Update timestamp in `funds.last_scraped_at`.

---

## 5. Aggregation Engine & AI Pipeline

### 5.1 SQL Aggregation Query
Post-scraping job computes consensus score, per-fund weight statistics, and ranks across tracked funds:

```sql
INSERT INTO stock_aggregations 
    (stock_id, consensus_score, total_weight_sum, weight_avg, weight_min, weight_max, rank)
SELECT 
    stock_id,
    COUNT(DISTINCT fund_id) AS consensus_score,
    COALESCE(SUM(weight_percentage), 0) AS total_weight_sum,
    AVG(CASE WHEN weight_percentage > 0 THEN weight_percentage END) AS weight_avg,
    MIN(CASE WHEN weight_percentage > 0 THEN weight_percentage END) AS weight_min,
    MAX(CASE WHEN weight_percentage > 0 THEN weight_percentage END) AS weight_max,
    ROW_NUMBER() OVER (ORDER BY COUNT(DISTINCT fund_id) DESC, SUM(weight_percentage) DESC) AS rank
FROM fund_holdings
GROUP BY stock_id
ON CONFLICT(stock_id) DO UPDATE SET
    consensus_score = excluded.consensus_score,
    total_weight_sum = excluded.total_weight_sum,
    weight_avg = excluded.weight_avg,
    weight_min = excluded.weight_min,
    weight_max = excluded.weight_max,
    rank = excluded.rank;
```

> `COALESCE(SUM(...), 0)` keeps `total_weight_sum` non-null (the column is `NOT NULL`) even when every holding has a null weight — which is the case for Groww, so ranking is effectively by `consensus_score`. `total_weight_sum` is retained only for internal ordering; it is **not** shown anywhere because summing one stock's weight across dozens of funds yields a meaningless figure. The display value is `weight_avg` (with the `weight_min`–`weight_max` range): the average Assets % a single holding fund allocates to the stock. The three per-fund columns are `null` when no underlying holding has a parsable weight.
>
> The three `weight_*` columns were added to an existing schema by migration (`ensureColumn`), so they land as `NULL`. Because `recompute()` only runs at the end of a scrape, an already-populated database would show `—` for every weight until the next scrape. On connect, `createDatabase()` therefore runs an idempotent `backfillWeightStats()` that derives the three columns straight from `fund_holdings` (guarded by `weight_percentage > 0`) so the stats are correct immediately.

### 5.2 Local AI Enrichment Task
1. Fetch top ranked stocks from `stock_aggregations` where `last_analyzed_at` is null or outdated.
2. Send prompt payload to local LLM:
   ```text
   Indian Stock: [Stock Name]
   Institutional Holding Count: Held by [consensus_score] top Large Cap MFs.
   Allocation Weight: avg [weight_avg]% per holding fund (range [weight_min]–[weight_max]%).

   Instructions: Return valid JSON containing:
   {
     "thesis": "2 sentence summary on institutional backing",
     "pros": ["pro 1", "pro 2", "pro 3"],
     "cons": ["con 1", "con 2", "con 3"]
   }
   ```
3. Parse structured JSON response and persist into `stock_aggregations`.

---

## 5A. Category Change Detection (Sell Signals)

After aggregation, the job compares each category's **current** stock set (the distinct stocks held by funds in that category, derived from `fund_holdings`) against the stored baseline in `category_stocks`:

1. For every distinct `funds.category`, compute `current` = stocks held by that category's funds and `previous` = the stored baseline.
2. Any stock in `previous` but not in `current` is a **removed** event; any stock in `current` but not in `previous` is an **added** event.
3. If at least one change was found, insert one `category_change_runs` row and one `category_stock_changes` row per event, then update the `category_stocks` baseline (insert added stocks, delete removed stocks) so the next run compares against the new state.
4. A run with no changes records nothing.

A **removal means the stock is no longer held by funds in that category**, which the frontend surfaces as a *sell signal* so the user can exit a position they entered on that category's consensus.

---

## 6. REST API Interface

* `GET /api/stocks/leaderboard`
  * **Params:** `limit` (default: 20), `offset` (default: 0)
  * **Response:** Ranked list of aggregated stocks, consensus score, total weight sum, pros, cons, and thesis.

* `GET /api/funds`
  * **Response:** List of tracked mutual funds and their last scraped timestamp.

* `POST /api/jobs/scrape`
  * **Response:** Manual trigger endpoint for scraping and aggregation pipeline.

* `GET /api/categories/:category/changes`
  * **Params:** `category` (URL-encoded category name, e.g. `Flexi%20Cap`).
  * **Response:** The most recent detection run's changes for that category: `{ category, run_id, run_at, removed: [{ stock_id, name }], added: [{ stock_id, name }] }`. `removed` is the sell signal (stocks that left the category since the previous run). `run_id`/`run_at` are `null` and both lists are empty when no change history exists for the category.