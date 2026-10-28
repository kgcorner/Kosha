import { chromium } from "playwright";

// Run `operation` with a Playwright page only when some source needs one;
// API sources get `null` and no Chromium is launched.
export async function withPageIfNeeded(needsBrowser, configuration, operation, runWithBrowser = withBrowser) {
  return needsBrowser ? runWithBrowser(configuration, operation) : operation(null);
}

export async function withBrowser(configuration, operation) {
  const browser = await chromium.launch({
    headless: configuration.browser?.headless ?? true
  });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(configuration.browser?.navigation_timeout_ms ?? 30000);
    page.setDefaultTimeout(configuration.browser?.action_timeout_ms ?? 10000);
    return await operation(page);
  } finally {
    await browser.close();
  }
}
