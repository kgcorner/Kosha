export class SourceAdapter {
  sourceName = "scrape";

  supports(_url) {
    throw new Error("SourceAdapter.support(url) must be implemented");
  }

  async discoverFunds(_page, _configuration) {
    throw new Error("SourceAdapter.discoverFunds(page, configuration) must be implemented");
  }

  async scrapeFundHoldings(_page, _url, _configuration) {
    throw new Error("SourceAdapter.scrapeFundHoldings(page, url, configuration) must be implemented");
  }

  async dumpDebug(page, context) {
    try {
      const preview = await page.locator("body").first().innerText();
      const snippet = preview.replace(/\s+/g, " ").trim().slice(0, 500);
      console.warn(`[${this.sourceName}:${context}] page body preview: ${snippet || "(empty)"}`);
    } catch (error) {
      console.warn(`[${this.sourceName}:${context}] could not read page body:`, error.message);
    }
  }
}
