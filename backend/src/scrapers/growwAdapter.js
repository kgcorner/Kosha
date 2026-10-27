import { SourceAdapter } from "./sourceAdapter.js";
import { READ_TIMEOUT_MS, parsePercentage, xpathLocator } from "./xpath.js";
import { extractStockMetrics } from "./stockMetrics.js";

export class GrowwAdapter extends SourceAdapter {
  constructor(homepage) {
    super();
    this.sourceName = "groww";
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

  // Groww's discovery XPath selects the <a> node itself, which carries both the
  // fund name (its text) and the link (its @href), so no sub-selectors are needed.
  async discoverFunds(page, configuration) {
    const xpath = configuration.category_xpath ?? configuration.selectors.mf_list_page.fund_row;
    await page.goto(configuration.category_url, { waitUntil: "domcontentloaded" });
    const title = await page.title();
    console.log(`[groww:discover] navigated to "${title}" (${page.url()})`);

    const nodes = xpathLocator(page, xpath);
    const nodeCount = await nodes.count();
    console.log(`[groww:discover] fund XPath matched ${nodeCount} node(s): ${xpath}`);

    const funds = [];
    for (let index = 0; index < nodeCount; index += 1) {
      const node = nodes.nth(index);
      // Bounded, tolerant reads: a node that detaches mid-read (SPA re-render)
      // resolves to null instead of blocking the 10s action timeout and crashing.
      let name = null;
      let href = null;
      try {
        name = (await node.textContent({ timeout: READ_TIMEOUT_MS }))?.replace(/\s+/g, " ").trim() ?? null;
      } catch {
        name = null;
      }
      try {
        href = await node.getAttribute("href", { timeout: READ_TIMEOUT_MS });
      } catch {
        href = null;
      }
      if (name && href) {
        funds.push({ name, url: new URL(href, configuration.category_url).href });
      } else {
        console.warn(`[groww:discover] node ${index} skipped (name=${JSON.stringify(name)}, href=${JSON.stringify(href)})`);
      }
    }

    if (funds.length === 0) {
      await this.dumpDebug(page, "discoverFunds");
    }
    return funds;
  }

  // Groww's holdings table has four columns — Name, Sector, Instruments,
  // Assets (weight %). The adapter reads every configured column and falls back
  // to the row's own text when a column selector is absent or unreadable, so a
  // markup tweak degrades gracefully instead of yielding null rows.
  async scrapeFundHoldings(page, url, configuration) {
    const selectors = configuration.selectors.mf_detail_page;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    if (selectors.view_all_holdings_button) {
      const viewAll = xpathLocator(page, selectors.view_all_holdings_button).first();
      if (await viewAll.count()) {
        await viewAll.click();
        await page.waitForTimeout(500);
        console.log(`[groww:holdings] clicked "View All" on ${url}`);
      }
    }

    const nodes = xpathLocator(page, selectors.holding_row);
    const nodeCount = await nodes.count();

    const holdings = [];
    for (let index = 0; index < nodeCount; index += 1) {
      const node = nodes.nth(index);
      const rowText = await readText(node);
      const name = (await readColumn(node, selectors.stock_name)) ?? rowText;

      if (!name) {
        console.warn(`[groww:holdings] holding node ${index} skipped (empty name) on ${url}`);
        continue;
      }

      holdings.push({
        name,
        sector: await readColumn(node, selectors.stock_sector),
        instrument: await readColumn(node, selectors.stock_instrument),
        weightPercentage: parsePercentage(await readColumn(node, selectors.stock_weight)),
        url: await readColumnUrl(node, selectors.stock_url, url)
      });
    }

    if (holdings.length === 0) {
      console.warn(`[groww:holdings] 0 holdings on ${url} (holding_row matched ${nodeCount} node(s))`);
      await this.dumpDebug(page, "scrapeFundHoldings");
    } else {
      console.log(`[groww:holdings] ${url} -> ${holdings.length} holding(s)`);
    }
    return holdings;
  }

  // Visit one stock's detail page and extract every metric declared under
  // `selectors.stock_page.metrics` (plus the config-driven fallbacks). Never
  // throws on a missing selector — absent metrics surface via `diagnostics`.
  async scrapeStockMetrics(page, url, configuration) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const waitMs = configuration.selectors.stock_page?.wait_ms ?? 0;
    if (waitMs > 0) await page.waitForTimeout(waitMs);

    const result = await extractStockMetrics({ page, configuration });
    const found = Object.values(result.provenance).filter((source) => source !== "none").length;
    console.log(`[groww:stock] ${url} -> ${found} metric(s) extracted (name=${JSON.stringify(result.name)})`);
    if (found === 0) await this.dumpDebug(page, "scrapeStockMetrics");
    return result;
  }
}

// Bounded, tolerant read: a node that detaches mid-read (SPA re-render) resolves
// to null instead of blocking the 10s action timeout and crashing the scrape.
async function readText(locator) {
  try {
    return (await locator.textContent({ timeout: READ_TIMEOUT_MS }))?.replace(/\s+/g, " ").trim() || null;
  } catch {
    return null;
  }
}

// Read one configured column relative to a holding row. Missing selectors yield
// null (the caller falls back); unreadable/empty cells also yield null.
async function readColumn(row, xpath) {
  if (!xpath) return null;
  try {
    const count = await xpathLocator(row, xpath).count();
    if (count === 0) return null;
    return await readText(xpathLocator(row, xpath).first());
  } catch {
    return null;
  }
}

// Resolve a holding row's stock-detail URL from a configured selector such as
// ".//td[...]//a/@href". Handles the `@attr` suffix and resolves relative hrefs
// against the fund page URL; returns null when absent.
async function readColumnUrl(row, xpath, baseUrl) {
  if (!xpath) return null;
  const attributeMatch = xpath.match(/\/@([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*$/);
  const expression = attributeMatch ? xpath.slice(0, attributeMatch.index) : xpath;
  const attributeName = attributeMatch?.[1] ?? "href";
  try {
    const locator = xpathLocator(row, expression);
    if ((await locator.count()) === 0) return null;
    const href = await locator.first().getAttribute(attributeName, { timeout: READ_TIMEOUT_MS });
    if (!href) return null;
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return href;
    }
  } catch {
    return null;
  }
}

