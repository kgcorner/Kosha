import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function loadConfig() {
  const app = readJson(path.resolve(backendRoot, process.env.APP_CONFIG ?? "config/app.json"));
  const scraping = readJson(path.resolve(backendRoot, process.env.SCRAPING_CONFIG ?? "config/scraping.json"));

  const hasCategories = Array.isArray(scraping.categories) && scraping.categories.length > 0;
  if (!scraping.source || !scraping.selectors || (!hasCategories && !scraping.category_url)) {
    throw new Error("Scraping configuration must define source, categories (or category_url), and selectors");
  }

  return {
    app: {
      ...app,
      port: Number(process.env.PORT ?? app.port),
      database_path: path.resolve(backendRoot, process.env.DATABASE_PATH ?? app.database_path)
    },
    scraping
  };
}
