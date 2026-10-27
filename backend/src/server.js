import cron from "node-cron";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/database.js";
import { createRepositories } from "./db/repositories.js";
import { MutualFundScraper } from "./scrapers/mutualFundScraper.js";
import { createSourceRegistry } from "./scrapers/sourceRegistry.js";
import { StockScraper } from "./scrapers/stockScraper.js";
import { ScrapeDryRunService } from "./services/scrapeDryRun.js";
import { AggregationService } from "./services/aggregationService.js";
import { OllamaService } from "./services/ollamaService.js";
import { ScrapeJob } from "./services/scrapeJob.js";

const { app: appConfig, scraping } = loadConfig();
console.log("Loaded configuration:", { app: appConfig, scraping });
const db = createDatabase(appConfig.database_path);
const repositories = createRepositories(db);
// A scrape only runs inside this process; clear any job left running by a crash.
const reaped = repositories.jobs.reapStale();
if (reaped > 0) console.log(`Marked ${reaped} stale scrape job(s) as failed on startup`);
const sourceRegistry = createSourceRegistry(scraping);
console.log("Initilizing Ollama Service with configuration:", appConfig.ai);
const ollamaService = new OllamaService(appConfig.ai);
const aggregationService = new AggregationService({
  repository: repositories.aggregation,
  ollamaService,
  aiConfiguration: appConfig.ai
});
const scrapeJob = new ScrapeJob({
  mutualFundScraper: new MutualFundScraper({
    configuration: scraping,
    sourceRegistry,
    fundRepository: repositories.funds
  }),
  stockScraper: new StockScraper({ configuration: scraping, sourceRegistry, repositories }),
  aggregationService,
  jobs: repositories.jobs,
  categoryChanges: repositories.categoryChanges
});
const dryRunService = new ScrapeDryRunService({ configuration: scraping, sourceRegistry });

const server = createApp({ repositories, scrapeJob, dryRunService }).listen(appConfig.port, () => {
  console.log(`Stock recommender API listening on port ${appConfig.port}`);
});

if (appConfig.scrape_cron) {
  if (!cron.validate(appConfig.scrape_cron)) {
    throw new Error(`Invalid SCRAPE_CRON expression: ${appConfig.scrape_cron}`);
  }
  cron.schedule(appConfig.scrape_cron, async () => {
    try {
      console.log("Scheduled scrape started", await scrapeJob.run());
    } catch (error) {
      console.error("Scheduled scrape failed:", error);
    }
  });
}

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
