/**
 * Normalise `scraping.json` category entries into a single `{ name, url, xpath }`
 * shape, accepting both the Groww form (`{ category, xpath }`) and the legacy
 * form (`{ name }`). Falls back to a synthetic `default` entry built from
 * `category_url`. Shared by the fund scraper and the dry-run service so both
 * always see the same category list.
 */
export function normalizeCategories(configuration) {
  const entries =
    Array.isArray(configuration.categories) && configuration.categories.length > 0
      ? configuration.categories
      : configuration.category_url
        ? [{ category: "default", url: configuration.category_url }]
        : null;
  if (!entries) {
    throw new Error("Scraping configuration must define categories or category_url");
  }
  return entries.map((entry) => ({
    name: entry.name ?? entry.category,
    url: entry.url,
    xpath: entry.xpath
  }));
}
