export class ScrapeJob {
  constructor({ mutualFundScraper, stockScraper, aggregationService, jobs, categoryChanges }) {
    this.mutualFundScraper = mutualFundScraper;
    this.stockScraper = stockScraper;
    this.aggregationService = aggregationService;
    // Repository of scrape job records; drives status/progress persistence.
    this.jobs = jobs;
    // Detects per-category stock membership changes between runs.
    this.categoryChanges = categoryChanges;
    this.running = false;
  }

  // Kick off a scrape in the background and return the job record immediately.
  // The HTTP caller gets a 202 + jobId without waiting for the (slow) browser work.
  start() {
    const active = this.findActive();
    if (active) {
      throw new Error(`A scrape job is already running (job #${active.id})`);
    }

    const job = this.jobs.create();
    console.log(`[scrape] job #${job.id} queued`);
    // Fire-and-forget: execute() records its own failures on the job row and is
    // written never to reject; the .catch() is a last-resort guard so a fire-and-
    // forget call can never surface as an unhandled rejection.
    this.execute(job.id).catch((error) => {
      console.error(`[scrape] job #${job.id} unexpected background error:`, error);
    });
    return this.jobs.get(job.id);
  }

  // A job is considered active if one is running in this process or a queued/running
  // row exists in the DB (survives restarts; an orphaned row is reclaimed on start).
  findActive() {
    if (this.running) return this.jobs.findRunning() ?? { id: null };
    return this.jobs.findRunning();
  }

  // Run a job end-to-end, persisting status/stage/counters to its row.
  async execute(jobId) {
    if (this.running) {
      this.jobs.fail(jobId, new Error("A scrape job is already running"));
      return;
    }
    this.running = true;
    this.jobs.start(jobId);
    const startedAt = Date.now();
    console.log(`[scrape] job #${jobId} started`);
    try {
      this.jobs.progress(jobId, { stage: "discovering_funds" });
      const funds = await this.mutualFundScraper.run();
      console.log(`[scrape] job #${jobId} fund discovery finished: ${funds.length} fund(s)`);

      this.jobs.progress(jobId, { stage: "scraping_holdings", counters: { funds: funds.length } });
      const stocks = await this.stockScraper.run(funds);
      console.log(`[scrape] job #${jobId} holdings scrape finished: ${stocks.stocks} unique stock(s)`);

      this.jobs.progress(jobId, { stage: "aggregating", counters: stocks });
      await this.aggregationService.run();
      console.log(`[scrape] job #${jobId} aggregation finished`);

      this.jobs.progress(jobId, { stage: "detecting_changes" });
      const changes = this.categoryChanges.detect();
      console.log(
        `[scrape] job #${jobId} category change detection finished: +${changes.added} / -${changes.removed}`
      );

      const result = {
        funds: funds.length,
        ...stocks,
        changes: { added: changes.added, removed: changes.removed }
      };
      this.jobs.complete(jobId, result);
      return result;
    } catch (error) {
      console.error(`[scrape] job #${jobId} failed:`, error);
      try {
        this.jobs.fail(jobId, error);
      } catch (persistError) {
        // Never let a failure to *record* the failure (e.g. DB closed on shutdown)
        // escape execute(), which is invoked fire-and-forget — that would crash the
        // process via an unhandled rejection.
        console.error(`[scrape] job #${jobId} could not persist failure state:`, persistError);
      }
      return null;
    } finally {
      this.running = false;
      console.log(`[scrape] job #${jobId} finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    }
  }

  // Awaitable run used by the cron scheduler and tests: starts a job, waits for it,
  // and returns its recorded result (or null on failure).
  async run() {
    const active = this.findActive();
    if (active) {
      throw new Error(`A scrape job is already running (job #${active.id})`);
    }
    const job = this.jobs.create();
    return this.execute(job.id);
  }
}

// Shape a stored job row for the API (parse the JSON result blob when present).
export function serializeJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    funds_found: job.funds_found,
    stocks: job.stocks,
    result: job.result ? JSON.parse(job.result) : null,
    error: job.error,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at
  };
}
