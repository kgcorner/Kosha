import { READ_TIMEOUT_MS, xpathLocator } from "./xpath.js";

/**
 * Extract every metric configured under `selectors.stock_page.metrics` from a
 * single stock detail page.
 *
 * A metric is resolved through (in order):
 *   1. the configured `metrics` XPath (used verbatim — these are the primary,
 *      hand-authored selectors);
 *   2. any `hints.<metric>.xpaths` fallbacks;
 *   3. any `hints.<metric>.payload` path into the page's embedded JSON payload
 *      (Groww ships a Next.js `__NEXT_DATA__` blob holding fundamentals,
 *      shareholding, financials and peers — far more stable than DOM markup);
 *   4. any `hints.<metric>.labels` text matches ("Market Cap" → next sibling).
 *
 * The winning strategy is recorded per metric in `provenance`, so a dry run can
 * show *where* a value came from while tuning the config.
 *
 * `hints.<metric>.payload` may be a single path (→ string) or an object of named
 * paths (→ object, e.g. `{ low, high }` for the 52-week range).
 *
 * Returns `{ url, name, metrics, provenance, payload, diagnostics }`. Never
 * throws on a missing selector: absent data is a first-class result.
 */
export async function extractStockMetrics({ page, configuration }) {
  const stockPage = configuration.selectors?.stock_page ?? {};
  const metricsConfig = stockPage.metrics ?? {};
  const hints = stockPage.hints ?? {};

  const metrics = {};
  const provenance = {};
  const diagnostics = [];

  const payloadRoot = await readPayload(page, stockPage.payload_root);
  const embedded = readPayloadSections(payloadRoot, stockPage.payload);

  for (const [group, fields] of Object.entries(metricsConfig)) {
    metrics[group] = {};
    for (const [key, xpath] of Object.entries(fields)) {
      const resolved = await resolveMetric({ page, xpath, hint: hints[key], payloadRoot });
      metrics[group][key] = resolved.value;
      provenance[key] = resolved.source;
      if (resolved.value === null && resolved.source !== "none") {
        diagnostics.push(`${key}: configured XPath matched nothing and no fallback value was found.`);
      }
    }
  }

  const name = await readTitle(page, metrics);
  const found = Object.values(provenance).filter((source) => source !== "none").length;
  if (found === 0) {
    diagnostics.push("No configured stock metric could be read from the page.");
  }

  return { url: safeUrl(page), name, metrics, provenance, payload: embedded, diagnostics };
}

// Resolve one metric through the configured strategies, tagging which one won.
async function resolveMetric({ page, xpath, hint, payloadRoot }) {
  const direct = await readXpathMetric(page, xpath);
  if (direct !== null) return { value: direct, source: "xpath" };

  for (const candidate of hint?.xpaths ?? []) {
    const value = await readXpathMetric(page, candidate);
    if (value !== null) return { value, source: "hint" };
  }

  const payloadValue = readPayloadHint(payloadRoot, hint?.payload);
  if (payloadValue !== null) return { value: payloadValue, source: "payload" };

  for (const label of hint?.labels ?? []) {
    const value = await readByLabel(page, label);
    if (value !== null) return { value, source: "label" };
  }

  return { value: null, source: "none" };
}

// An XPath may be a union of alternatives, may point at an attribute, and may
// either target a single node (→ text) or a bare "no predicate" container
// selector (→ list of child row texts, for history-style metrics).
async function readXpathMetric(page, xpath) {
  if (!xpath) return null;
  const attributeMatch = xpath.match(/\/@([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*$/);
  const expression = attributeMatch ? xpath.slice(0, attributeMatch.index) : xpath;

  // A bare node-set selector (e.g. "...//tr") yields a trend list: one string per
  // node (or a single string when only one node matches).
  const branches = expandUnion(expression);
  if (!attributeMatch && branches.every((branch) => /\/\/[a-zA-Z][\w:-]*$/.test(branch))) {
    return readNodesetText(page, expression);
  }

  const targeted = await readFirstText(page, expression, attributeMatch?.[1]);
  if (targeted !== null) return targeted;

  // A union of mixed selectors: fall back to the node list as a last resort.
  return attributeMatch ? null : readNodesetText(page, expression);
}

// Read a plain node-set: a single match yields its text, several yield a list.
async function readNodesetText(page, xpath) {
  const values = await readTextList(page, xpath);
  if (values === null) return null;
  return values.length === 1 ? values[0] : values;
}

// Read the first matched node's text (or attribute). Bounded so a detached SPA
// node resolves to null quickly instead of blocking the action timeout.
async function readFirstText(page, xpath, attributeName) {
  for (const candidate of expandUnion(xpath)) {
    try {
      const locator = xpathLocator(page, candidate);
      if ((await locator.count()) === 0) continue;
      const target = locator.first();
      const text = attributeName
        ? await target.getAttribute(attributeName, { timeout: READ_TIMEOUT_MS })
        : await target.textContent({ timeout: READ_TIMEOUT_MS });
      const clean = normalize(text);
      if (clean) return clean;
    } catch {
      // Try the next alternative / treat as unreadable.
    }
  }
  return null;
}

async function readTextList(page, xpath) {
  for (const candidate of expandUnion(xpath)) {
    try {
      const locator = xpathLocator(page, candidate);
      const count = await locator.count();
      if (count === 0) continue;
      const values = [];
      for (let index = 0; index < Math.min(count, 50); index += 1) {
        const text = normalize(await locator.nth(index).textContent({ timeout: READ_TIMEOUT_MS }));
        if (text) values.push(text);
      }
      if (values.length > 0) return values;
    } catch {
      // Try the next alternative.
    }
  }
  return null;
}

// Match a visible label ("Market Cap") and read the value next to it. This
// covers Groww's label/value div pairs where the primary table XPath is stale.
async function readByLabel(page, label) {
  if (!label) return null;
  const literal = label.replace(/'/g, "''");
  const locator = xpathLocator(page, `//*[normalize-space(text())='${literal}']`);
  let count = 0;
  try {
    count = await locator.count();
  } catch {
    return null;
  }
  for (let index = 0; index < Math.min(count, 10); index += 1) {
    try {
      const value = await locator.nth(index).evaluate((node, labelText) => {
        const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim() || null;
        const sibling = node.nextElementSibling ? clean(node.nextElementSibling.textContent) : null;
        if (sibling) return sibling;
        const parent = node.parentElement ? clean(node.parentElement.textContent) : null;
        return parent && parent !== labelText ? parent.replace(labelText, "").trim() || null : null;
      }, label);
      if (value) return value;
    } catch {
      // Detached node — try the next match.
    }
  }
  return null;
}

// Read the embedded JSON payload (Groww's Next.js `__NEXT_DATA__`) through the
// configured root path.
async function readPayload(page, rootPath) {
  if (!rootPath) return null;
  try {
    return await page.evaluate((path) => {
      const mount = document.getElementById("__NEXT_DATA__");
      if (!mount) return null;
      let data;
      try {
        data = JSON.parse(mount.textContent);
      } catch {
        return null;
      }
      let current = data;
      for (const token of path.split(".")) {
        if (current == null) return null;
        current = current[token];
      }
      return current ?? null;
    }, rootPath);
  } catch {
    return null;
  }
}

function readPayloadSections(payloadRoot, sections) {
  const result = {};
  for (const [name, path] of Object.entries(sections ?? {})) {
    const value = resolvePath(payloadRoot, path);
    if (value !== undefined && value !== null) result[name] = value;
  }
  return result;
}

// `hints.<metric>.payload` may be a path (→ value) or a map of named paths.
function readPayloadHint(payloadRoot, payloadHint) {
  if (!payloadHint || payloadRoot == null) return null;
  if (typeof payloadHint === "string") return resolvePath(payloadRoot, payloadHint) ?? null;
  const mapped = {};
  for (const [name, path] of Object.entries(payloadHint)) {
    const value = resolvePath(payloadRoot, path);
    if (value !== undefined && value !== null) mapped[name] = value;
  }
  return Object.keys(mapped).length > 0 ? mapped : null;
}

/**
 * Walk a dotted path over the payload. A token may carry a `[selector]` suffix:
 * on an array it selects the item whose `name`/`shortName` matches; on an object
 * it selects that key (e.g. `fundamentals[Market Cap].value`).
 */
function resolvePath(root, path) {
  let current = root;
  for (const token of String(path).split(".")) {
    if (current == null) return undefined;
    const match = token.match(/^([^[\]]+)(?:\[(.+)\])?$/);
    if (!match) return undefined;
    const [, key, selector] = match;
    current = current[key];
    if (selector !== undefined) {
      if (Array.isArray(current)) {
        current = current.find(
          (item) =>
            item?.name === selector ||
            item?.shortName === selector ||
            item?.title === selector
        );
      } else if (current && typeof current === "object") {
        current = current[selector];
      } else {
        return undefined;
      }
    }
  }
  return current;
}

// Prefer the configured ticker/metric title; fall back to the document title.
async function readTitle(page, metrics) {
  const ticker = metrics?.core_identifiers_and_market_metrics?.ticker_and_exchange;
  if (typeof ticker === "string" && ticker) return ticker;
  try {
    return normalize(await page.title());
  } catch {
    return null;
  }
}

function safeUrl(page) {
  try {
    return page.url();
  } catch {
    return null;
  }
}

// Split a top-level XPath union ("a | b") into individual expressions.
function expandUnion(xpath) {
  return String(xpath)
    .split(" | ")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalize(value) {
  return (value ?? "").replace(/\s+/g, " ").trim() || null;
}
