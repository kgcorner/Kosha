import { SourceAdapter } from "./sourceAdapter.js";
import { parsePercentage, readXPathValue, xpathLocator } from "./xpath.js";

export class MoneycontrolAdapter extends SourceAdapter {
  constructor(homepage) {
    super();
    this.sourceName = "mc";
    this.homepage = new URL(homepage);
  }

  supports(url) {
    try {
      const candidate = new URL(url);
      return candidate.protocol === this.homepage.protocol &&
        candidate.hostname === this.homepage.hostname;
    } catch {
      return false;
    }
  }

  async discoverFunds(page, configuration) {
    const selectors = configuration.selectors.mf_list_page;
    await page.goto(configuration.category_url, { waitUntil: "domcontentloaded" });
    const title = await page.title();
    console.log(`[mc:discover] navigated to "${title}" (${page.url()})`);
    const rows = xpathLocator(page, selectors.fund_row);
    const rowCount = await rows.count();
    console.log(`[mc:discover] fund_row XPath matched ${rowCount} row(s): ${selectors.fund_row}`);
    const funds = [];

    for (let index = 0; index < rowCount; index += 1) {
      const row = rows.nth(index);
      const name = await readXPathValue(row, selectors.fund_name);
      const href = await readXPathValue(row, selectors.fund_link);
      if (name && href) {
        funds.push({ name, url: new URL(href, configuration.category_url).href });
      } else {
        console.warn(`[mc:discover] row ${index} skipped (name=${JSON.stringify(name)}, href=${JSON.stringify(href)})`);
      }
    }

    if (funds.length === 0) {
      await this.dumpDebug(page, "discoverFunds");
    }
    return funds;
  }

  async scrapeFundHoldings(page, url, configuration) {
    const selectors = configuration.selectors.mf_detail_page;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    if (selectors.view_all_holdings_button) {
      const viewAll = xpathLocator(page, selectors.view_all_holdings_button).first();
      if (await viewAll.count()) {
        await viewAll.click();
        await page.waitForTimeout(500);
        console.log(`[mc:holdings] clicked "View All" on ${url}`);
      }
    }

    const rows = xpathLocator(page, selectors.holding_row);
    const rowCount = await rows.count();
    const holdings = [];
    for (let index = 0; index < rowCount; index += 1) {
      const row = rows.nth(index);
      const name = await readXPathValue(row, selectors.stock_name);
      const weightText = await readXPathValue(row, selectors.stock_weight);
      const weightPercentage = parsePercentage(weightText);
      if (name && weightPercentage !== null) {
        holdings.push({ name, weightPercentage });
      }
    }
    if (holdings.length === 0) {
      console.warn(`[mc:holdings] 0 holdings on ${url} (holding_row matched ${rowCount} row(s))`);
      await this.dumpDebug(page, "holdings");
    }
    return holdings;
  }
}
