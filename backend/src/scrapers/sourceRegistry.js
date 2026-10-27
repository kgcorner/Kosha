import { MoneycontrolAdapter } from "./moneycontrolAdapter.js";
import { GrowwAdapter } from "./growwAdapter.js";
import { MfdataAdapter } from "./mfdataAdapter.js";

export class SourceRegistry {
  constructor(adapters, defaultUrl) {
    this.adapters = adapters;
    this.defaultUrl = defaultUrl;
  }

  resolve(url) {
    const adapter = this.adapters.find((candidate) => candidate.supports(url));
    if (!adapter) throw new Error(`No scraper source supports URL: ${url}`);
    return adapter;
  }
}

export function createSourceRegistry(configuration) {
  const homepage = resolveHomepage(configuration);
  const adapters = {
    moneycontrol: () => new MoneycontrolAdapter(homepage),
    groww: () => new GrowwAdapter(homepage),
    mfdata: () => new MfdataAdapter(homepage)
  };
  const factory = adapters[configuration.source];
  if (!factory) throw new Error(`Unknown scraper source "${configuration.source}"`);
  return new SourceRegistry([factory()], homepage);
}

function resolveHomepage(configuration) {
  if (configuration.homepage_url) return configuration.homepage_url;
  const reference = configuration.category_url ?? configuration.categories?.[0]?.url;
  if (!reference) {
    throw new Error("Scraping configuration must define homepage_url, category_url, or categories");
  }
  return new URL(reference).origin;
}
