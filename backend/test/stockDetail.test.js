import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db/database.js";
import { createRepositories } from "../src/db/repositories.js";
import { createApp } from "../src/app.js";

function seed() {
  const db = createDatabase(":memory:");
  const repositories = createRepositories(db);
  const a = repositories.funds.upsert({ name: "Alpha Small Cap Fund", url: "u://a", category: "Small Cap" });
  const b = repositories.funds.upsert({ name: "Beta Flexi Cap Fund", url: "u://b", category: "Flexi Cap" });
  repositories.funds.upsert({ name: "Gamma Small Cap Fund", url: "u://c", category: "Small Cap" });
  repositories.holdings.replaceFundHoldings(a.id, [
    { name: "Karur Vysya Bank Ltd.", isin: "INE036D01028", sector: "Banks", weightPercentage: 2.5, quantity: 1000, marketValueCr: 25.5, asOf: "2026-09-30" },
    { name: "Other Co", isin: "INE000000001", weightPercentage: 1 }
  ]);
  repositories.holdings.replaceFundHoldings(b.id, [
    { name: "KARUR VYSYA BANK LIMITED", isin: "INE036D01028", sector: "Private Bank", weightPercentage: 1.5, quantity: 500, marketValueCr: 12.25, asOf: "2026-09-30" }
  ]);
  repositories.aggregation.recompute();
  const stockId = db.prepare("SELECT id FROM stocks WHERE isin = ?").get("INE036D01028").id;
  return { db, repositories, stockId };
}

test("holdings persist quantity, market value, as-of date and the first sector seen", () => {
  const { db, stockId } = seed();
  try {
    const rows = db.prepare("SELECT weight_percentage, quantity, market_value_cr, as_of FROM fund_holdings WHERE stock_id = ? ORDER BY weight_percentage DESC").all(stockId);
    assert.deepEqual(rows, [
      { weight_percentage: 2.5, quantity: 1000, market_value_cr: 25.5, as_of: "2026-09-30" },
      { weight_percentage: 1.5, quantity: 500, market_value_cr: 12.25, as_of: "2026-09-30" }
    ]);
    assert.equal(db.prepare("SELECT sector FROM stocks WHERE id = ?").get(stockId).sector, "Banks");
  } finally {
    db.close();
  }
});

test("stocks.detail returns holdings by weight, totals, and no fundamentals before any fetch", () => {
  const { db, repositories, stockId } = seed();
  try {
    const detail = repositories.stocks.detail(stockId);
    assert.deepEqual(detail.stock, { id: stockId, name: "Karur Vysya Bank Ltd.", isin: "INE036D01028", symbol: null, sector: "Banks", url: null });
    assert.deepEqual(detail.holdings.map((h) => [h.fund_name, h.category, h.weight_percentage]), [
      ["Alpha Small Cap Fund", "Small Cap", 2.5],
      ["Beta Flexi Cap Fund", "Flexi Cap", 1.5]
    ]);
    assert.deepEqual(detail.totals, { funds_holding: 2, total_quantity: 1500, total_market_value_cr: 37.75, latest_as_of: "2026-09-30" });
    assert.deepEqual(detail.fundamentals_cached, []);
    assert.equal(repositories.stocks.detail(99999), null);
  } finally {
    db.close();
  }
});

test("GET /api/stocks/:id serves the stored detail with the fund signal; leaderboard route still wins", async () => {
  const { db, repositories, stockId } = seed();
  const server = createApp({ repositories }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const response = await fetch(`${base}/stocks/${stockId}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.totals.funds_holding, 2);
    assert.equal(body.fund_signal.funds_holding, 2);
    assert.deepEqual(
      body.fund_signal.categories.map((c) => [c.category, c.funds_holding, c.funds_in_category]),
      [["Flexi Cap", 1, 1], ["Small Cap", 1, 2]]
    );
    assert.equal((await fetch(`${base}/stocks/99999`)).status, 404);
    assert.equal((await fetch(`${base}/stocks/abc`)).status, 404);
    assert.ok(Array.isArray(await (await fetch(`${base}/stocks/leaderboard`)).json()));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
