import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const schema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS funds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT UNIQUE NOT NULL,
  category TEXT,
  last_scraped_at DATETIME
);

CREATE TABLE IF NOT EXISTS stocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  url TEXT
);

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

CREATE TABLE IF NOT EXISTS stock_aggregations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id INTEGER UNIQUE NOT NULL,
  consensus_score INTEGER NOT NULL,
  -- Raw sum of the Assets % across every fund holding the stock. Retained for
  -- compatibility and internal ordering only; it is NOT a meaningful figure to
  -- display (a stock held by 50 funds at ~1% each would read "50%"). Use the
  -- per-fund weight_avg / weight_min / weight_max below for anything user-facing.
  total_weight_sum REAL NOT NULL,
  -- Per-fund weight statistics: the average Assets % a single holding fund
  -- allocates to this stock, and the min/max across those funds (the range).
  -- NULL when no holding of the stock carries a parsable weight.
  weight_avg REAL,
  weight_min REAL,
  weight_max REAL,
  rank INTEGER NOT NULL,
  ai_thesis TEXT,
  ai_pros TEXT,
  ai_cons TEXT,
  last_analyzed_at DATETIME,
  FOREIGN KEY(stock_id) REFERENCES stocks(id) ON DELETE CASCADE
);

-- Full metric set scraped from each stock's own detail page (price, valuation
-- ratios, financials, shareholding, peers ...). Stored as JSON keyed by the
-- metric group/field names in config/scraping.json so new config fields flow
-- through without a schema change. stock_url is where the data came from and
-- provenance records the config strategy that produced each value.
CREATE TABLE IF NOT EXISTS stock_metrics (
  stock_id INTEGER PRIMARY KEY,
  stock_url TEXT,
  page_title TEXT,
  metrics TEXT,
  provenance TEXT,
  raw TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(stock_id) REFERENCES stocks(id) ON DELETE CASCADE
);

-- Lazily fetched fundamentals (one row per stock per section: profile,
-- financials, shareholding, pledge). Filled only when a client requests a
-- stock's fundamentals, never by the scrape job.
CREATE TABLE IF NOT EXISTS stock_fundamentals (
  stock_id INTEGER NOT NULL,
  section TEXT NOT NULL,
  provider TEXT NOT NULL,
  symbol TEXT,
  payload TEXT NOT NULL,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (stock_id, section),
  FOREIGN KEY(stock_id) REFERENCES stocks(id) ON DELETE CASCADE
);

-- Cached on-demand LLM analyses, one per stock per "held" flag. Reused while
-- input_hash (digest of fund signal + fundamentals + model + prompt) matches.
CREATE TABLE IF NOT EXISTS stock_analyses (
  stock_id INTEGER NOT NULL,
  held INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (stock_id, held),
  FOREIGN KEY(stock_id) REFERENCES stocks(id) ON DELETE CASCADE
);

-- Market-wide provider data (FII/DII flows, market pulse), one row per key,
-- refreshed at most once per calendar day and shared by every stock.
CREATE TABLE IF NOT EXISTS market_data (
  key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  payload TEXT NOT NULL,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scrape_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'queued',
  stage TEXT,
  funds_found INTEGER,
  stocks INTEGER,
  result TEXT,
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  finished_at DATETIME
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
  change_type TEXT NOT NULL,
  detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES category_change_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(stock_id) REFERENCES stocks(id) ON DELETE CASCADE
);
`;

export function createDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.exec(schema);
  ensureColumn(db, "funds", "category", "TEXT");
  ensureColumn(db, "stocks", "url", "TEXT");
  ensureColumn(db, "stocks", "isin", "TEXT");
  // ISIN is the stable stock identity when a source provides it (AMC disclosures
  // spell one company several ways: "Ltd." / "Limited" / "EQ - ...").
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_stocks_isin ON stocks(isin) WHERE isin IS NOT NULL");
  // Exchange symbol resolved lazily by the fundamentals provider (e.g. Tapetide).
  ensureColumn(db, "stocks", "symbol", "TEXT");
  ensureColumn(db, "stock_aggregations", "weight_avg", "REAL");
  ensureColumn(db, "stock_aggregations", "weight_min", "REAL");
  ensureColumn(db, "stock_aggregations", "weight_max", "REAL");
  makeWeightNullable(db);
  // Extra per-holding facts from richer sources (AMC disclosures): shares held,
  // market value and disclosure date. Added after makeWeightNullable, which may
  // rebuild fund_holdings with the original column set.
  ensureColumn(db, "fund_holdings", "quantity", "REAL");
  ensureColumn(db, "fund_holdings", "market_value_cr", "REAL");
  ensureColumn(db, "fund_holdings", "as_of", "TEXT");
  ensureColumn(db, "stocks", "sector", "TEXT");
  // Data sections an analysis was generated from (lets a same-day analysis made
  // with missing data be redone once that data arrives).
  ensureColumn(db, "stock_analyses", "input_sections", "TEXT");
  backfillWeightStats(db);
  return db;
}

// The per-fund weight stats are normally written by AggregationService.recompute()
// at the end of a scrape, but an existing database that was migrated (the columns
// are added as NULL) has no safe place to get them until the next scrape runs —
// the leaderboard would show "—" for every row in the meantime. Recompute them
// here straight from fund_holdings, the source of truth, so the current stats are
// available immediately. Idempotent: the values are derived, never accumulated.
function backfillWeightStats(db) {
  db.exec(`
    UPDATE stock_aggregations
       SET weight_avg = (
             SELECT AVG(weight_percentage) FROM fund_holdings
              WHERE fund_holdings.stock_id = stock_aggregations.stock_id
                AND weight_percentage > 0
           ),
           weight_min = (
             SELECT MIN(weight_percentage) FROM fund_holdings
              WHERE fund_holdings.stock_id = stock_aggregations.stock_id
                AND weight_percentage > 0
           ),
           weight_max = (
             SELECT MAX(weight_percentage) FROM fund_holdings
              WHERE fund_holdings.stock_id = stock_aggregations.stock_id
                AND weight_percentage > 0
           )
  `);
}

// SQLite cannot ALTER a column to drop NOT NULL, so rebuild fund_holdings if an
// older schema still marks weight_percentage NOT NULL (Groww supplies no weights).
function makeWeightNullable(db) {
  const column = db.prepare("PRAGMA table_info(fund_holdings)").all()
    .find((item) => item.name === "weight_percentage");
  if (!column || column.notnull === 0) return;
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE fund_holdings_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fund_id INTEGER NOT NULL,
          stock_id INTEGER NOT NULL,
          weight_percentage REAL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(fund_id) REFERENCES funds(id) ON DELETE CASCADE,
          FOREIGN KEY(stock_id) REFERENCES stocks(id) ON DELETE CASCADE,
          UNIQUE(fund_id, stock_id)
        );
        INSERT INTO fund_holdings_new (id, fund_id, stock_id, weight_percentage, updated_at)
          SELECT id, fund_id, stock_id, weight_percentage, updated_at FROM fund_holdings;
        DROP TABLE fund_holdings;
        ALTER TABLE fund_holdings_new RENAME TO fund_holdings;
      `);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function ensureColumn(db, table, column, type) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
