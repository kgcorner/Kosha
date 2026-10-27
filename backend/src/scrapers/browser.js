import { chromium } from "playwright";

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
