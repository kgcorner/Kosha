export function xpathLocator(pageOrLocator, xpath) {
  const expression = xpath.startsWith("xpath=") ? xpath : `xpath=${xpath}`;
  return pageOrLocator.locator(expression);
}

// Very short per-read timeout. Playwright's locator.textContent()/getAttribute()
// auto-wait for the element to be present, using the page's default action timeout
// (10s here). On a client-rendered SPA (Groww) an element can exist at count() time
// yet detach before the read — Playwright then blocks for the full 10s and throws
// TimeoutError, killing the whole scrape. Bounding each read to a few milliseconds
// keeps "missing/raced" a first-class, instantly-tolerated result.
export const READ_TIMEOUT_MS = 250;

export async function readXPathValue(pageOrLocator, configuredXPath, attributeName) {
  if (!configuredXPath) return null;

  const attributeMatch = configuredXPath.match(/\/@([a-zA-Z_:][-a-zA-Z0-9_:.]*)$/);
  const xpath = attributeMatch ? configuredXPath.slice(0, attributeMatch.index) : configuredXPath;
  const locator = xpathLocator(pageOrLocator, xpath).first();
  if (attributeName || attributeMatch) {
    return locator.getAttribute(attributeName ?? attributeMatch[1]);
  }
  return (await locator.textContent())?.replace(/\s+/g, " ").trim() ?? null;
}

export function parsePercentage(value) {
  const normalized = value?.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return normalized ? Number(normalized[0]) : null;
}
