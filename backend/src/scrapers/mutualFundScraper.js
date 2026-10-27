import { withPageIfNeeded } from "./browser.js";
import { normalizeCategories } from "./categoryList.js";

export class MutualFundScraper {
  constructor({ configuration, sourceRegistry, fundRepository }) {
    this.configuration = configuration;
    this.sourceRegistry = sourceRegistry;
    this.fundRepository = fundRepository;
  }

  async run() {
    const fundsByUrl = new Map();
    const categories = this.categoryList();
    const needsBrowser = categories.some((category) => this.sourceRegistry.resolve(category.url).requiresBrowser !== false);

    await withPageIfNeeded(needsBrowser, this.configuration, async (page) => {
      for (const category of categories) {
        const adapter = this.sourceRegistry.resolve(category.url);
        console.log(`[scrape:funds] scanning category "${category.name}": ${category.url}`);
        const discovered = await adapter.discoverFunds(page, {
          ...this.configuration,
          category_url: category.url,
          category_xpath: category.xpath
        });
        console.log(`[scrape:funds] "${category.name}" -> ${discovered.length} fund(s) found`);
        for (const fund of discovered) {
          fundsByUrl.set(fund.url, { ...fund, category: category.name });
        }
      }
    });

    const discovered = [...fundsByUrl.values()];
    const limit = this.configuration.scrape?.fund_limit ?? 0;
    const funds = limit > 0 ? discovered.slice(0, limit) : discovered;
    console.log(`[scrape:funds] ${discovered.length} unique fund(s) after de-dupe${limit > 0 ? `, limited to ${funds.length}` : ""}`);
    return funds.map((fund) => this.fundRepository.upsert(fund));
  }

  categoryList() {
    return normalizeCategories(this.configuration);
  }
}
