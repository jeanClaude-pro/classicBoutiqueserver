// Reports chart time series against a real MongoDB replica set: buckets are
// business days, sums equal the category accounting PERIOD figures, and the
// shareholder category scope is enforced by the server.
const test = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, createIntegrationContext } = require("./helpers/integrationContext");
const Sale = require("../models/Sale");

const ctx = createIntegrationContext();
test.before(ctx.setup);
test.after(ctx.teardown);
test.beforeEach(ctx.reset);
const itest = (name, fn) => test(name, { skip: SKIP }, fn);

const series = (query, role = "superadmin") =>
  ctx.request("GET", `/analytics/timeseries?${new URLSearchParams(query)}`, { token: ctx.token(role) });
const summary = (query, role = "superadmin") =>
  ctx.request("GET", `/analytics/summary?${new URLSearchParams(query)}`, { token: ctx.token(role) });

async function recordedSale(items, isoDate) {
  const response = await ctx.sell(items);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  await ctx.backdate(Sale, response.body._id, isoDate);
  return response.body;
}

itest("time series buckets business days and matches the accounting period to the cent", async () => {
  const clothes = await ctx.product("CLOTHES", 10, 25);
  const shoes = await ctx.product("SHOES", 20, 50);
  // 2026-09-10 in Lubumbashi starts at 2026-09-09T22:00:00.000Z.
  await recordedSale([{ product: clothes, quantity: 2 }], "2026-09-09T22:00:00.000Z");
  await recordedSale([{ product: clothes, quantity: 1 }, { product: shoes, quantity: 1 }], "2026-09-11T10:00:00.000Z");
  await recordedSale([{ product: shoes, quantity: 3 }], "2026-09-09T21:59:59.999Z"); // 2026-09-09: outside

  const response = await series({ from: "2026-09-10", to: "2026-09-12", granularity: "day" });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const body = response.body;
  assert.equal(body.source, "mongodb-aggregation");
  assert.deepEqual(body.series.map((row) => row.date), ["2026-09-10", "2026-09-11", "2026-09-12"]);
  assert.deepEqual(body.series.map((row) => row.revenue), [50, 75, 0]);
  assert.deepEqual(body.series.map((row) => row.sales), [1, 1, 0], "a two-category sale is one sale");
  assert.equal(body.series[1].byCategory.SHOES.grossProfit, 30);

  const period = await summary({ from: "2026-09-10", to: "2026-09-12", timeframe: "day" });
  assert.equal(period.status, 200);
  for (const category of ["CLOTHES", "SHOES"]) {
    const accounting = period.body.data.categoryBreakdown[category];
    const totals = body.totals.byCategory[category];
    assert.deepEqual(
      [totals.revenue, totals.costOfGoodsSold, totals.grossProfit, totals.companyExpenses, totals.netResult],
      [accounting.revenue, accounting.costOfGoodsSold, accounting.grossProfit, accounting.companyExpenses, accounting.netProfit],
      category,
    );
  }
});

itest("time series pins shareholders to their category and validates its query", async () => {
  const clothes = await ctx.product("CLOTHES", 10, 25);
  const shoes = await ctx.product("SHOES", 20, 50);
  await recordedSale([{ product: clothes, quantity: 1 }, { product: shoes, quantity: 1 }], "2026-09-11T10:00:00.000Z");

  const shoesView = await series({ from: "2026-09-10", to: "2026-09-12", category: "CLOTHES" }, "shoesShareholder");
  assert.equal(shoesView.status, 200);
  assert.deepEqual(shoesView.body.categories, ["SHOES"]);
  assert.equal(shoesView.body.totals.revenue, 50);
  assert.deepEqual(Object.keys(shoesView.body.totals.byCategory), ["SHOES"]);

  const filtered = await series({ from: "2026-09-10", to: "2026-09-12", category: "CLOTHES" });
  assert.deepEqual(filtered.body.categories, ["CLOTHES"]);
  assert.equal(filtered.body.totals.revenue, 25);

  assert.equal((await series({ from: "2026-09-12", to: "2026-09-10" })).status, 400);
  assert.equal((await series({ from: "2020-01-01", to: "2026-01-01", granularity: "day" })).status, 400);
  assert.equal((await series({}, "manager")).status, 403, "Reports is not a manager default");
});

itest("a single day is bucketed by business hour and still matches the day's accounting", async () => {
  const clothes = await ctx.product("CLOTHES", 10, 25);
  const shoes = await ctx.product("SHOES", 20, 50);
  // Lubumbashi is UTC+2: 22:00Z on the 9th is 00:00 on the 10th, 10:30Z is 12:30.
  await recordedSale([{ product: clothes, quantity: 2 }], "2026-09-09T22:00:00.000Z");
  await recordedSale([{ product: clothes, quantity: 1 }, { product: shoes, quantity: 1 }], "2026-09-10T10:30:00.000Z");
  await recordedSale([{ product: shoes, quantity: 3 }], "2026-09-10T22:00:00.000Z"); // the 11th: outside

  const response = await series({ from: "2026-09-10", to: "2026-09-10" });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const body = response.body;
  assert.equal(body.granularity, "hour");
  assert.equal(body.series.length, 24);
  assert.deepEqual([body.series[0].date, body.series[0].hour, body.series[12].date], ["2026-09-10T00", 0, "2026-09-10T12"]);
  assert.deepEqual(body.series.filter((row) => row.revenue !== 0).map((row) => [row.hour, row.revenue, row.sales]), [[0, 50, 1], [12, 75, 1]]);

  const day = await series({ from: "2026-09-10", to: "2026-09-10", granularity: "day" });
  assert.deepEqual(body.totals, day.body.totals, "hours add up to the day exactly");
});
