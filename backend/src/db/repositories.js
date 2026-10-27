export function createRepositories(db) {
  const upsertFund = db.prepare(`
    INSERT INTO funds (name, url, category) VALUES (@name, @url, @category)
    ON CONFLICT(url) DO UPDATE SET
      name = excluded.name,
      category = COALESCE(funds.category, excluded.category)
  `);
  const getFundByUrl = db.prepare("SELECT id, name, url, category FROM funds WHERE url = ?");

  return {
    funds: {
      upsert(fund) {
        upsertFund.run(fund);
        return getFundByUrl.get(fund.url);
      },
      list() {
        return db.prepare("SELECT id, name, url, category, last_scraped_at FROM funds ORDER BY name").all();
      },
      /** Distinct non-null categories, for the leaderboard's category filter. */
      listCategories() {
        return db.prepare(
          "SELECT DISTINCT category FROM funds WHERE category IS NOT NULL ORDER BY category"
        ).all().map((row) => row.category);
      },
      markScraped: db.prepare("UPDATE funds SET last_scraped_at = CURRENT_TIMESTAMP WHERE id = ?")
    },
    jobs: {
      create() {
        const result = db.prepare("INSERT INTO scrape_jobs (status) VALUES ('queued')").run();
        return db.prepare("SELECT * FROM scrape_jobs WHERE id = ?").get(result.lastInsertRowid);
      },
      get(jobId) {
        return db.prepare("SELECT * FROM scrape_jobs WHERE id = ?").get(jobId) ?? null;
      },
      list(limit = 20) {
        return db.prepare("SELECT * FROM scrape_jobs ORDER BY id DESC LIMIT ?").all(limit);
      },
      // Mark the job started. Also fails any previously-orphaned 'running'/'queued'
      // rows (e.g. after a crash) so findRunning reflects reality on a fresh start.
      start(jobId) {
        db.prepare(`
          UPDATE scrape_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP, stage = 'started'
          WHERE id = ?
        `).run(jobId);
      },
      progress(jobId, { stage, counters = {} }) {
        db.prepare(`
          UPDATE scrape_jobs
          SET stage = ?,
              funds_found = COALESCE(?, funds_found),
              stocks = COALESCE(?, stocks)
          WHERE id = ?
        `).run(
          stage ?? null,
          counters.funds ?? null,
          counters.stocks ?? null,
          jobId
        );
      },
      complete(jobId, result) {
        db.prepare(`
          UPDATE scrape_jobs
          SET status = 'completed', stage = 'completed', result = ?, error = NULL,
              finished_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(JSON.stringify(result), jobId);
      },
      fail(jobId, error) {
        db.prepare(`
          UPDATE scrape_jobs
          SET status = 'failed', stage = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(error?.message ?? String(error), jobId);
      },
      findRunning() {
        return db.prepare(
          "SELECT * FROM scrape_jobs WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 1"
        ).get() ?? null;
      },
      // Call once at server startup: a scrape only ever runs inside the current
      // process, so any queued/running row present on boot is stale (from a crash
      // or restart) and must be marked failed or it would block all future scrapes.
      reapStale() {
        const result = db.prepare(`
          UPDATE scrape_jobs
          SET status = 'failed', stage = 'failed',
              error = COALESCE(error, 'job superseded by server restart'),
              finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
          WHERE status IN ('queued', 'running')
        `).run();
        return result.changes;
      }
    },
    holdings: {
      replaceFundHoldings(fundId, holdings) {
        const replace = db.transaction((items) => {
          db.prepare("DELETE FROM fund_holdings WHERE fund_id = ?").run(fundId);
          const insert = db.prepare(`
            INSERT INTO fund_holdings (fund_id, stock_id, weight_percentage)
            VALUES (?, ?, ?)
          `);
          // A fund's holding list can legitimately contain the same stock more than
          // once (e.g. Groww renders repeated/duplicate rows). fund_holdings has a
          // UNIQUE(fund_id, stock_id) constraint, so collapse to one row per stock
          // before inserting — otherwise the second insert throws SQLITE_CONSTRAINT_UNIQUE.
          const seen = new Set();
          let skipped = 0;
          for (const holding of items) {
            const stockId = this.upsertStock(holding);
            if (seen.has(stockId)) {
              skipped += 1;
              continue;
            }
            seen.add(stockId);
            insert.run(fundId, stockId, holding.weightPercentage);
          }
          if (skipped > 0) {
            console.warn(
              `[holdings] fund ${fundId}: dropped ${skipped} duplicate holding row(s) before insert`
            );
          }
        });
        replace(holdings);
        this.markFundScraped(fundId);
      },
      upsertStock: (stock) => {
        // Sources that supply an ISIN (fund-disclosures) are matched on it, so
        // spelling variants of one company collapse to a single stock row.
        if (stock.isin) {
          const byIsin = db.prepare("SELECT id FROM stocks WHERE isin = ?").get(stock.isin);
          if (byIsin) {
            if (stock.url) db.prepare("UPDATE stocks SET url = COALESCE(url, ?) WHERE id = ?").run(stock.url, byIsin.id);
            return byIsin.id;
          }
          // Adopt a legacy name-only row for the same company, else insert.
          const byName = db.prepare("SELECT id, isin FROM stocks WHERE name = ?").get(stock.name);
          if (byName && !byName.isin) {
            db.prepare("UPDATE stocks SET isin = ?, url = COALESCE(url, ?) WHERE id = ?")
              .run(stock.isin, stock.url ?? null, byName.id);
            return byName.id;
          }
          const name = byName ? `${stock.name} (${stock.isin})` : stock.name;
          return Number(db.prepare("INSERT INTO stocks (name, url, isin) VALUES (?, ?, ?)")
            .run(name, stock.url ?? null, stock.isin).lastInsertRowid);
        }
        db.prepare(`
          INSERT INTO stocks (name, url) VALUES (@name, @url)
          ON CONFLICT(name) DO UPDATE SET
            name = excluded.name,
            url = COALESCE(excluded.url, stocks.url)
        `).run({ name: stock.name, url: stock.url ?? null });
        return db.prepare("SELECT id FROM stocks WHERE name = ?").get(stock.name).id;
      },
      markFundScraped: (fundId) => db.prepare(
        "UPDATE funds SET last_scraped_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(fundId)
    },
    stocks: {
      // Every stock that has a detail-page URL captured from a fund's holdings
      // table but no scraped metrics yet (or whose metrics predate the last
      // scrape). Backs the full pipeline's per-stock page visit.
      pendingMetrics(limit = 0) {
        const base = `
          SELECT s.id, s.name, s.url
          FROM stocks s
          JOIN stock_aggregations a ON a.stock_id = s.id
          LEFT JOIN stock_metrics m ON m.stock_id = s.id
          WHERE s.url IS NOT NULL AND s.url <> ''
            AND (m.stock_id IS NULL OR m.updated_at < COALESCE(a.last_scraped_at, '1970-01-01'))
          ORDER BY a.rank
        `;
        return limit > 0
          ? db.prepare(`${base} LIMIT ?`).all(limit)
          : db.prepare(base).all();
      },
      getById(stockId) {
        return db.prepare("SELECT id, name, url, isin, symbol FROM stocks WHERE id = ?").get(stockId) ?? null;
      },
      setSymbol(stockId, symbol) {
        db.prepare("UPDATE stocks SET symbol = ? WHERE id = ?").run(symbol, stockId);
      }
    },
    analyses: {
      get(stockId, held) {
        return parseAnalysisRow(db.prepare(
          "SELECT stock_id, held, provider, model, input_hash, result, created_at FROM stock_analyses WHERE stock_id = ? AND held = ?"
        ).get(stockId, held ? 1 : 0));
      },
      upsert(stockId, held, { provider, model, inputHash, result }) {
        db.prepare(`
          INSERT INTO stock_analyses (stock_id, held, provider, model, input_hash, result, created_at)
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(stock_id, held) DO UPDATE SET
            provider = excluded.provider,
            model = excluded.model,
            input_hash = excluded.input_hash,
            result = excluded.result,
            created_at = excluded.created_at
        `).run(stockId, held ? 1 : 0, provider, model, inputHash, JSON.stringify(result));
        return this.get(stockId, held);
      }
    },
    fundamentals: {
      list(stockId) {
        return db.prepare(
          "SELECT section, provider, symbol, payload, fetched_at FROM stock_fundamentals WHERE stock_id = ?"
        ).all(stockId).map(parseFundamentalsRow);
      },
      upsert(stockId, section, { provider, symbol, payload }) {
        db.prepare(`
          INSERT INTO stock_fundamentals (stock_id, section, provider, symbol, payload, fetched_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(stock_id, section) DO UPDATE SET
            provider = excluded.provider,
            symbol = excluded.symbol,
            payload = excluded.payload,
            fetched_at = excluded.fetched_at
        `).run(stockId, section, provider, symbol ?? null, JSON.stringify(payload ?? null));
        return parseFundamentalsRow(db.prepare(
          "SELECT section, provider, symbol, payload, fetched_at FROM stock_fundamentals WHERE stock_id = ? AND section = ?"
        ).get(stockId, section));
      }
    },
    stockMetrics: {
      // One JSON blob per stock; group/field keys mirror config/scraping.json so
      // adding a metric to the config needs no migration.
      upsert(stockId, { url, title, metrics, provenance, raw }) {
        db.prepare(`
          INSERT INTO stock_metrics (stock_id, stock_url, page_title, metrics, provenance, raw, updated_at)
          VALUES (@stockId, @url, @title, @metrics, @provenance, @raw, CURRENT_TIMESTAMP)
          ON CONFLICT(stock_id) DO UPDATE SET
            stock_url = excluded.stock_url,
            page_title = excluded.page_title,
            metrics = excluded.metrics,
            provenance = excluded.provenance,
            raw = excluded.raw,
            updated_at = CURRENT_TIMESTAMP
        `).run({
          stockId,
          url: url ?? null,
          title: title ?? null,
          metrics: JSON.stringify(metrics ?? {}),
          provenance: JSON.stringify(provenance ?? {}),
          raw: raw ? JSON.stringify(raw) : null
        });
      },
      get(stockId) {
        const row = db.prepare("SELECT * FROM stock_metrics WHERE stock_id = ?").get(stockId);
        return row ? deserializeMetrics(row) : null;
      }
    },
    aggregation: {
      // Kosha's own signal for one stock — how many tracked funds hold it,
      // overall and per category — so the LLM can weigh fund-manager consensus
      // alongside fundamentals.
      signalFor(stockId) {
        const overall = db.prepare(`
          SELECT consensus_score AS funds_holding, rank, weight_avg, weight_min, weight_max
          FROM stock_aggregations WHERE stock_id = ?
        `).get(stockId) ?? null;
        const categories = db.prepare(`
          SELECT f.category,
                 COUNT(DISTINCT h.fund_id) AS funds_holding,
                 (SELECT COUNT(*) FROM funds all_f WHERE all_f.category = f.category) AS funds_in_category,
                 AVG(CASE WHEN h.weight_percentage > 0 THEN h.weight_percentage END) AS weight_avg
          FROM fund_holdings h
          JOIN funds f ON f.id = h.fund_id
          WHERE h.stock_id = ? AND f.category IS NOT NULL
          GROUP BY f.category
          ORDER BY funds_holding DESC
        `).all(stockId);
        return { ...(overall ?? { funds_holding: 0, rank: null }), categories };
      },
      recompute() {
        db.prepare(`
          INSERT INTO stock_aggregations
            (stock_id, consensus_score, total_weight_sum, weight_avg, weight_min, weight_max, rank)
          SELECT
            stock_id,
            COUNT(DISTINCT fund_id),
            COALESCE(SUM(weight_percentage), 0),
            AVG(CASE WHEN weight_percentage > 0 THEN weight_percentage END),
            MIN(CASE WHEN weight_percentage > 0 THEN weight_percentage END),
            MAX(CASE WHEN weight_percentage > 0 THEN weight_percentage END),
            ROW_NUMBER() OVER (
              ORDER BY COUNT(DISTINCT fund_id) DESC, SUM(weight_percentage) DESC
            )
          FROM fund_holdings
          GROUP BY stock_id
          ON CONFLICT(stock_id) DO UPDATE SET
            consensus_score = excluded.consensus_score,
            total_weight_sum = excluded.total_weight_sum,
            weight_avg = excluded.weight_avg,
            weight_min = excluded.weight_min,
            weight_max = excluded.weight_max,
            rank = excluded.rank,
            last_analyzed_at = CASE
              WHEN stock_aggregations.consensus_score <> excluded.consensus_score
                OR stock_aggregations.total_weight_sum <> excluded.total_weight_sum
              THEN NULL
              ELSE stock_aggregations.last_analyzed_at
            END
        `).run();
        db.prepare(`
          DELETE FROM stock_aggregations
          WHERE stock_id NOT IN (SELECT DISTINCT stock_id FROM fund_holdings)
        `).run();
      },
      /**
       * Consensus leaderboard. Unfiltered, ranks come from the global
       * `stock_aggregations.rank`. When `category` is supplied the stock set is
       * scoped to funds of that category and the rank is recomputed within the
       * category (so "the top Small Cap stock" is a category-local #1).
       * `categories` per row lists every category holding the stock, so the UI
       * can show which caps a stock belongs to.
       */
      leaderboard(limit, offset, category = null) {
        const rows = this._leaderboardStatement(category).all(
          ...this._leaderboardBindings(category),
          limit,
          offset
        );
        return rows.map((item) => this._toLeaderboardRow(item));
      },
      _leaderboardStatement(category) {
        if (category) {
          return db.prepare(`
            SELECT s.id AS stock_id, s.name, s.url AS stock_url,
                   COUNT(DISTINCT scoped.fund_id) AS consensus_score,
                   COALESCE(SUM(scoped.weight_percentage), 0) AS total_weight_sum,
                   AVG(CASE WHEN scoped.weight_percentage > 0 THEN scoped.weight_percentage END) AS weight_avg,
                   MIN(CASE WHEN scoped.weight_percentage > 0 THEN scoped.weight_percentage END) AS weight_min,
                   MAX(CASE WHEN scoped.weight_percentage > 0 THEN scoped.weight_percentage END) AS weight_max,
                   ROW_NUMBER() OVER (
                     ORDER BY COUNT(DISTINCT scoped.fund_id) DESC,
                              COALESCE(SUM(scoped.weight_percentage), 0) DESC,
                              s.name ASC
                   ) AS rank,
                   a.ai_thesis AS thesis, a.ai_pros AS pros, a.ai_cons AS cons,
                   a.last_analyzed_at,
                   m.metrics AS metrics,
                   (SELECT GROUP_CONCAT(DISTINCT f2.category)
                      FROM fund_holdings fh2
                      JOIN funds f2 ON f2.id = fh2.fund_id
                     WHERE fh2.stock_id = s.id AND f2.category IS NOT NULL) AS categories
            FROM fund_holdings scoped
            JOIN stocks s ON s.id = scoped.stock_id
            JOIN funds f ON f.id = scoped.fund_id AND f.category = ?
            LEFT JOIN stock_aggregations a ON a.stock_id = s.id
            LEFT JOIN stock_metrics m ON m.stock_id = s.id
            GROUP BY s.id
            ORDER BY rank
            LIMIT ? OFFSET ?
          `);
        }
        return db.prepare(`
          SELECT s.id AS stock_id, s.name, s.url AS stock_url,
                 a.consensus_score, a.total_weight_sum,
                 a.weight_avg, a.weight_min, a.weight_max, a.rank,
                 a.ai_thesis AS thesis, a.ai_pros AS pros, a.ai_cons AS cons,
                 a.last_analyzed_at,
                 m.metrics AS metrics,
                 (SELECT GROUP_CONCAT(DISTINCT f2.category)
                    FROM fund_holdings fh2
                    JOIN funds f2 ON f2.id = fh2.fund_id
                   WHERE fh2.stock_id = s.id AND f2.category IS NOT NULL) AS categories
          FROM stock_aggregations a
          JOIN stocks s ON s.id = a.stock_id
          LEFT JOIN stock_metrics m ON m.stock_id = s.id
          ORDER BY a.rank
          LIMIT ? OFFSET ?
        `);
      },
      _leaderboardBindings(category) {
        return category ? [category] : [];
      },
      _toLeaderboardRow(item) {
        return {
          ...item,
          metrics: item.metrics ? JSON.parse(item.metrics) : null,
          categories: item.categories ? item.categories.split(",") : [],
          pros: item.pros ? JSON.parse(item.pros) : [],
          cons: item.cons ? JSON.parse(item.cons) : []
        };
      },
      unanalyzed(limit) {
        return db.prepare(`
          SELECT s.name, a.stock_id, a.consensus_score, a.total_weight_sum,
                 a.weight_avg, a.weight_min, a.weight_max,
                 m.metrics AS metrics
          FROM stock_aggregations a
          JOIN stocks s ON s.id = a.stock_id
          LEFT JOIN stock_metrics m ON m.stock_id = s.id
          WHERE a.last_analyzed_at IS NULL
          ORDER BY a.rank
          LIMIT ?
        `).all(limit).map((row) => ({
          ...row,
          metrics: row.metrics ? JSON.parse(row.metrics) : null
        }));
      },
      saveAnalysis: db.prepare(`
        UPDATE stock_aggregations
        SET ai_thesis = ?, ai_pros = ?, ai_cons = ?, last_analyzed_at = CURRENT_TIMESTAMP
        WHERE stock_id = ?
      `)
    },
    // Per-category stock-change detection: compares each category's current stock
    // set (from fund_holdings) against the stored baseline (category_stocks) and,
    // when it differs, logs added/removed events grouped by a run so the API can
    // report which stocks left a category since the previous run (a sell signal).
    categoryChanges: {
      detect() {
        const categories = db.prepare(
          "SELECT DISTINCT category FROM funds WHERE category IS NOT NULL"
        ).all().map((row) => row.category);

        const currentFor = db.prepare(`
          SELECT DISTINCT fh.stock_id
          FROM fund_holdings fh
          JOIN funds f ON f.id = fh.fund_id
          WHERE f.category = ?
        `);
        const previousFor = db.prepare(
          "SELECT stock_id FROM category_stocks WHERE category = ?"
        );

        const changes = [];
        for (const category of categories) {
          const current = new Set(currentFor.all(category).map((row) => row.stock_id));
          const previous = new Set(previousFor.all(category).map((row) => row.stock_id));
          for (const stockId of previous) {
            if (!current.has(stockId)) changes.push({ category, stockId, type: "removed" });
          }
          for (const stockId of current) {
            if (!previous.has(stockId)) changes.push({ category, stockId, type: "added" });
          }
        }

        const added = changes.filter((change) => change.type === "added").length;
        const removed = changes.filter((change) => change.type === "removed").length;
        if (changes.length === 0) return { runId: null, added: 0, removed: 0 };

        const runId = db.transaction(() => {
          const id = db.prepare("INSERT INTO category_change_runs DEFAULT VALUES").run().lastInsertRowid;
          const logChange = db.prepare(`
            INSERT INTO category_stock_changes (run_id, category, stock_id, change_type)
            VALUES (?, ?, ?, ?)
          `);
          const upsertCurrent = db.prepare(`
            INSERT INTO category_stocks (category, stock_id, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(category, stock_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
          `);
          const deleteCurrent = db.prepare(
            "DELETE FROM category_stocks WHERE category = ? AND stock_id = ?"
          );
          for (const change of changes) {
            logChange.run(id, change.category, change.stockId, change.type);
            if (change.type === "removed") {
              deleteCurrent.run(change.category, change.stockId);
            } else {
              upsertCurrent.run(change.category, change.stockId);
            }
          }
          return id;
        })();

        return { runId, added, removed };
      },

      // Return the most recent run's changes for a category: the stocks removed
      // (the sell signal) and added since the run before. Empty lists when the
      // category has no recorded change history.
      latestChanges(category) {
        const run = db.prepare(`
          SELECT run_id FROM category_stock_changes
          WHERE category = ?
          ORDER BY run_id DESC
          LIMIT 1
        `).get(category);
        if (!run) return { category, run_id: null, run_at: null, removed: [], added: [] };

        const rows = db.prepare(`
          SELECT c.change_type, s.id AS stock_id, s.name
          FROM category_stock_changes c
          JOIN stocks s ON s.id = c.stock_id
          WHERE c.run_id = ? AND c.category = ?
          ORDER BY s.name
        `).all(run.run_id, category);
        const runAt = db.prepare(
          "SELECT started_at FROM category_change_runs WHERE id = ?"
        ).get(run.run_id)?.started_at ?? null;

        const toStock = (row) => ({ stock_id: row.stock_id, name: row.name });
        return {
          category,
          run_id: run.run_id,
          run_at: runAt,
          removed: rows.filter((row) => row.change_type === "removed").map(toStock),
          added: rows.filter((row) => row.change_type === "added").map(toStock)
        };
      }
    }
  };
}

// Shape a stock_metrics row for the API (JSON columns parsed, timestamp kept).
export function deserializeMetrics(row) {
  return {
    stock_id: row.stock_id,
    stock_url: row.stock_url,
    page_title: row.page_title,
    metrics: row.metrics ? JSON.parse(row.metrics) : {},
    provenance: row.provenance ? JSON.parse(row.provenance) : {},
    raw: row.raw ? JSON.parse(row.raw) : null,
    updated_at: row.updated_at
  };
}

function parseFundamentalsRow(row) {
  if (!row) return null;
  let payload = null;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = row.payload;
  }
  return { ...row, payload };
}

function parseAnalysisRow(row) {
  if (!row) return null;
  return { ...row, held: Boolean(row.held), result: JSON.parse(row.result) };
}
