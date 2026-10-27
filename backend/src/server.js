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
import { TapetideClient } from "./services/tapetideClient.js";
import { DEFAULT_SECTIONS, FundamentalsService } from "./services/fundamentalsService.js";
import { createLlmProvider } from "./services/llmProviders.js";
import { StockAnalysisService } from "./services/stockAnalysisService.js";

const { app: appConfig, scraping } = loadConfig();
console.log("Loaded configuration:", { app: appConfig, scraping });
const db = createDatabase(appConfig.database_path);
const repositories = createRepositories(db);
// A scrape only runs inside this process; clear any job left running by a crash.
const reaped = repositories.jobs.reapStale();
if (reaped > 0) console.log(`Marked ${reaped} stale scrape job(s) as failed on startup`);
const sourceRegistry = createSourceRegistry(scraping);
// One OpenAI-compatible LLM provider (OpenRouter by default, or a local LM
// Studio/Ollama server) shared by the on-demand stock analysis and the
// optional scrape-time thesis.
const llm = createLlmProvider(appConfig.llm ?? {});
console.log("LLM provider:", llm.describe(), llm.configured ? "" : "(not configured — analysis endpoint will report it)");
const ollamaService = new OllamaService({ ...appConfig.ai, provider: llm });
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
const fundamentalsService = createFundamentalsService(appConfig.fundamentals, repositories);
const analysisService = new StockAnalysisService({ repositories, fundamentalsService, llm });

const server = createApp({ repositories, scrapeJob, dryRunService, fundamentalsService, analysisService }).listen(appConfig.port, () => {
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

// Fundamentals are lazy: built here but only called by
// GET /api/stocks/:id/fundamentals. The token is read from the environment
// (never from a committed config file).
function createFundamentalsService(configuration = {}, repos) {
  if (configuration.enabled === false) return null;
  const token = process.env[configuration.token_env ?? "TAPETIDE_TOKEN"];
  if (!token) {
    console.warn("Fundamentals: TAPETIDE_TOKEN not set — /api/stocks/:id/fundamentals will serve cached data only");
  }
  const client = new TapetideClient({
    token,
    baseUrl: configuration.base_url ?? "https://mcp.tapetide.com",
    timeoutMs: configuration.timeout_ms ?? 30000
  });
  const ttl = configuration.ttl_hours ?? {};
  const sections = Object.fromEntries(
    Object.entries(DEFAULT_SECTIONS)
      .filter(([name]) => !configuration.sections || configuration.sections.includes(name))
      .map(([name, definition]) => [name, { ...definition, ttl_hours: ttl[name] ?? definition.ttl_hours }])
  );
  return new FundamentalsService({ repositories: repos, client, sections });
}
