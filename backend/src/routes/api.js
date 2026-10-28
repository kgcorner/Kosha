import { Router } from "express";
import { serializeJob } from "../services/scrapeJob.js";
import { DRY_RUN_DEFAULT_LIMIT, DRY_RUN_MAX_LIMIT } from "../services/scrapeDryRun.js";

export function createApiRouter({ repositories, scrapeJob, dryRunService, fundamentalsService = null, analysisService = null }) {
  const router = Router();

  router.get("/stocks/leaderboard", (request, response, next) => {
    try {
      const limit = parseInteger(request.query.limit, 20, 1, 100);
      const offset = parseInteger(request.query.offset, 0, 0, 1000000);
      const category = parseCategory(request.query.category);
      response.json(repositories.aggregation.leaderboard(limit, offset, category));
    } catch (error) {
      next(error);
    }
  });

  // Everything the scrape stored about one stock (no external calls): ranking,
  // per-category coverage, every holding fund with weight/quantity/value,
  // recent category changes, and when fundamentals were last fetched.
  router.get("/stocks/:id", (request, response, next) => {
    try {
      const id = Number(request.params.id);
      const detail = Number.isInteger(id) ? repositories.stocks.detail(id) : null;
      if (!detail) {
        return response.status(404).json({ error: `Stock #${request.params.id} not found` });
      }
      response.json({ ...detail, fund_signal: repositories.aggregation.signalFor(id) });
    } catch (error) {
      next(error);
    }
  });

  // Full metric set scraped from a stock's own detail page (price, valuation
  // ratios, financials, shareholding, peers). 404 until that stock has been
  // visited by a scrape.
  router.get("/stocks/:id/metrics", (request, response, next) => {
    try {
      const id = Number(request.params.id);
      const stock = Number.isInteger(id) ? repositories.stocks.getById(id) : null;
      if (!stock) {
        return response.status(404).json({ error: `Stock #${request.params.id} not found` });
      }
      const metrics = repositories.stockMetrics.get(id);
      response.json({
        stock_id: stock.id,
        name: stock.name,
        stock_url: stock.url,
        metrics: metrics?.metrics ?? null,
        provenance: metrics?.provenance ?? null,
        page_title: metrics?.page_title ?? null,
        updated_at: metrics?.updated_at ?? null
      });
    } catch (error) {
      next(error);
    }
  });

  // Lazily loaded fundamentals (quote/valuation, financial statements,
  // shareholding, promoter pledge) plus Kosha's fund-consensus signal, for the
  // UI detail view and LLM analysis. Calls the provider only for missing or
  // expired sections; everything is cached per section in SQLite.
  //   ?sections=profile,pledge  fetch a subset
  // The provider is called at most once per stock per section per day.
  router.get("/stocks/:id/fundamentals", (request, response, next) => {
    try {
      if (!fundamentalsService) {
        return response.status(503).json({ error: "Fundamentals provider is not configured" });
      }
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return response.status(404).json({ error: `Stock #${request.params.id} not found` });
      }
      const sections = typeof request.query.sections === "string" && request.query.sections.trim()
        ? request.query.sections.split(",").map((value) => value.trim()).filter(Boolean)
        : null;
      fundamentalsService
        .getFundamentals(id, { sections })
        .then((result) => {
          if (!result) return response.status(404).json({ error: `Stock #${request.params.id} not found` });
          response.json(result);
        })
        .catch(next);
    } catch (error) {
      next(error);
    }
  });

  // On-demand LLM verdict for one stock from Kosha's fund signal + fundamentals.
  //   ?held=true     the user owns it → HOLD/SELL (default BUY/IGNORE)
  //   ?refresh=true  re-run the model even if inputs are unchanged
  // Cached per (stock, held) until the inputs change.
  router.get("/stocks/:id/analysis", (request, response, next) => {
    try {
      if (!analysisService) {
        return response.status(503).json({ error: "LLM analysis is not configured" });
      }
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return response.status(404).json({ error: `Stock #${request.params.id} not found` });
      }
      const flag = (value) => ["1", "true", "yes"].includes(String(value ?? "").toLowerCase());
      analysisService
        .analyze(id, { held: flag(request.query.held), refresh: flag(request.query.refresh) })
        .then((result) => {
          if (!result) return response.status(404).json({ error: `Stock #${request.params.id} not found` });
          response.json(result);
        })
        .catch((error) => {
          const status = error.code === "not_configured" ? 503 : error.code === "rate_limited" ? 429 : 502;
          response.status(status).json({ error: error.message, code: error.code ?? null });
        });
    } catch (error) {
      next(error);
    }
  });

  // Market-wide context (FII/DII cash flows, market pulse) shared by every
  // stock; fetched from the provider at most once per calendar day.
  router.get("/market", (_request, response, next) => {
    if (!fundamentalsService) {
      return response.status(503).json({ error: "Fundamentals provider is not configured" });
    }
    fundamentalsService.getMarketContext().then((result) => response.json(result)).catch(next);
  });

  router.get("/funds", (_request, response, next) => {
    try {
      response.json(repositories.funds.list());
    } catch (error) {
      next(error);
    }
  });

  // Distinct fund categories, used by the leaderboard's category filter.
  router.get("/categories", (_request, response, next) => {
    try {
      response.json(repositories.funds.listCategories());
    } catch (error) {
      next(error);
    }
  });

  // Selector heat-and-trial: scrape one category → one fund → up to `limit`
  // holdings with every parsed data point. Read-only (nothing persisted), so it
  // is safe to run repeatedly while tuning config/scraping.json.
  router.get("/scrape/dry-run", (request, response, next) => {
    try {
      const limit = parseInteger(request.query.limit, DRY_RUN_DEFAULT_LIMIT, 1, DRY_RUN_MAX_LIMIT);
      const category = parseCategory(request.query.category);
      const fund = parseCategory(request.query.fund);
      dryRunService
        .run({ category, fund, limit })
        .then((result) => response.json(result))
        .catch(next);
    } catch (error) {
      next(error);
    }
  });

  // The categories a dry run can sample (also the config's canonical list).
  router.get("/scrape/categories", (_request, response, next) => {
    try {
      response.json(dryRunService.categories().map((entry) => entry.name));
    } catch (error) {
      next(error);
    }
  });

  // Start a scrape in the background. Returns 202 + a jobId immediately so the
  // client never blocks on the (slow) browser scrape. Poll GET /api/jobs/:id.
  router.post("/jobs/scrape", (_request, response, next) => {
    try {
      const job = scrapeJob.start();
      response.status(202).json(serializeJob(job));
    } catch (error) {
      next(error);
    }
  });

  // Monitor a single scrape job by id.
  router.get("/jobs/:id", (request, response, next) => {
    try {
      const id = Number(request.params.id);
      const job = Number.isInteger(id) ? repositories.jobs.get(id) : null;
      if (!job) {
        return response.status(404).json({ error: `Scrape job #${request.params.id} not found` });
      }
      response.json(serializeJob(job));
    } catch (error) {
      next(error);
    }
  });

  // List recent scrape jobs (newest first).
  router.get("/jobs", (request, response, next) => {
    try {
      const limit = parseInteger(request.query.limit, 20, 1, 100);
      response.json(repositories.jobs.list(limit).map(serializeJob));
    } catch (error) {
      next(error);
    }
  });

  // Report which stocks entered/left a category since the previous run, so a user
  // can be told to sell a stock that was removed from a category.
  router.get("/categories/:category/changes", (request, response, next) => {
    try {
      const category = decodeURIComponent(request.params.category);
      response.json(repositories.categoryChanges.latestChanges(category));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function parseCategory(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function parseInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error("Pagination parameters must be non-negative integers");
  const number = Number(value);
  if (number < minimum || number > maximum) {
    throw new Error(`Pagination parameter must be between ${minimum} and ${maximum}`);
  }
  return number;
}
