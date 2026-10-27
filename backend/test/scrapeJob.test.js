import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import { ScrapeJob, serializeJob } from "../src/services/scrapeJob.js";

// Build a ScrapeJob over fake collaborators so no browser is launched. The
// mutualFundScraper / stockScraper / aggregationService just resolve with canned
// data after a microtask, which is enough to exercise the async job lifecycle.
function buildScrapeJob({ repositories, fundDelay = 0, holdingsResult, fail } = {}) {
  const mutualFundScraper = {
    async run() {
      if (fail === "funds") throw new Error("fund discovery boom");
      await new Promise((resolve) => setTimeout(resolve, fundDelay));
      return [
        { id: 1, name: "Fund A", url: "https://groww.in/fund-a" },
        { id: 2, name: "Fund B", url: "https://groww.in/fund-b" }
      ];
    }
  };
  const stockScraper = {
    async run() {
      if (fail === "holdings") throw new Error("holdings boom");
      return holdingsResult ?? { stocks: 42 };
    }
  };
  const aggregationService = {
    async run() {
      if (fail === "aggregate") throw new Error("aggregate boom");
    }
  };
  const categoryChanges = {
    detect() {
      return { runId: 1, added: 0, removed: 0 };
    }
  };
  return new ScrapeJob({ mutualFundScraper, stockScraper, aggregationService, jobs: repositories.jobs, categoryChanges });
}

test("serializeJob parses the result JSON and returns null for missing result", () => {
  const parsed = serializeJob({ id: 3, status: "completed", stage: "completed", result: '{"funds":2,"stocks":42}', error: null });
  assert.equal(parsed.id, 3);
  assert.deepEqual(parsed.result, { funds: 2, stocks: 42 });

  const noResult = serializeJob({ id: 4, status: "queued", stage: null, result: null });
  assert.equal(noResult.result, null);
  assert.equal(serializeJob(null), null);
});

test("start() returns immediately with a queued job and a jobId", async () => {
  const db = createDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    const scrapeJob = buildScrapeJob({ repositories, fundDelay: 50 });

    const job = scrapeJob.start();
    // Returned synchronously — before the background work resolves.
    assert.ok(Number.isInteger(job.id), "expected a numeric jobId");
    assert.equal(["queued", "running"].includes(job.status), true, "job is queued/running right after start");

    // The background job completes on its own; wait for it and assert final state.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const final = repositories.jobs.get(job.id);
    assert.equal(final.status, "completed");
    assert.deepEqual(JSON.parse(final.result), { funds: 2, stocks: 42, changes: { added: 0, removed: 0 } });
    assert.equal(final.funds_found, 2);
    assert.equal(final.stocks, 42);
  } finally {
    db.close();
  }
});

test("execute() records progress stages and counters, then completes", async () => {
  const db = createDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    const scrapeJob = buildScrapeJob({ repositories, holdingsResult: { stocks: 3 } });

    const result = await scrapeJob.execute(repositories.jobs.create().id);
    assert.deepEqual(result, { funds: 2, stocks: 3, changes: { added: 0, removed: 0 } });

    const [job] = repositories.jobs.list(1);
    assert.equal(job.status, "completed");
    assert.equal(job.stage, "completed");
    assert.equal(job.funds_found, 2);
    assert.equal(job.stocks, 3);
    assert.ok(job.finished_at, "finished_at is set on completion");
  } finally {
    db.close();
  }
});

test("a failing scrape marks the job failed with the error message (no throw)", async () => {
  const db = createDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    const scrapeJob = buildScrapeJob({ repositories, fail: "holdings" });

    const jobId = repositories.jobs.create().id;
    const result = await scrapeJob.execute(jobId); // resolves to null, does not throw
    assert.equal(result, null);

    const job = repositories.jobs.get(jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.stage, "failed");
    assert.equal(job.error, "holdings boom");
  } finally {
    db.close();
  }
});

test("findActive prevents starting a second concurrent scrape", async () => {
  const db = createDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    const scrapeJob = buildScrapeJob({ repositories, fundDelay: 60 });

    const first = scrapeJob.start();
    assert.throws(() => scrapeJob.start(), /already running \(job #/);

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(repositories.jobs.get(first.id).status, "completed");
    // Once finished, a new scrape can start again.
    const second = scrapeJob.start();
    assert.notEqual(second.id, first.id);
    await new Promise((resolve) => setTimeout(resolve, 120));
  } finally {
    db.close();
  }
});

test("an orphaned running row (from a crash) is reaped on startup, unblocking new scrapes", async () => {
  const db = createDatabase(":memory:");
  try {
    const repositories = createRepositories(db);
    // Simulate a previous process that crashed mid-run, leaving a running row.
    const orphan = repositories.jobs.create();
    repositories.jobs.start(orphan.id);
    assert.equal(repositories.jobs.findRunning().id, orphan.id);

    // On the next boot, server.js calls reapStale() — the stale row is failed...
    assert.equal(repositories.jobs.reapStale(), 1);
    assert.equal(repositories.jobs.get(orphan.id).status, "failed");
    assert.equal(repositories.jobs.get(orphan.id).error, "job superseded by server restart");
    assert.equal(repositories.jobs.findRunning(), null);

    // ...so a fresh ScrapeJob can start a new scrape without blocking forever.
    const restarted = buildScrapeJob({ repositories });
    assert.equal(restarted.findActive(), null);
    const job = restarted.start();
    assert.notEqual(job.id, orphan.id);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(repositories.jobs.get(job.id).status, "completed");
  } finally {
    db.close();
  }
});
