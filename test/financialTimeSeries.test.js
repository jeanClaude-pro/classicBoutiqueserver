const test = require("node:test");
const assert = require("node:assert/strict");
const {
  bucketKeys,
  parseTimeSeriesQuery,
  saleSeriesPipeline,
  companyExpenseSeriesPipeline,
} = require("../services/financialTimeSeriesService");

test("time-series query defaults to the last 30 business days", () => {
  // 00:30 on 19 October in Lubumbashi is still 18 October in UTC.
  const parsed = parseTimeSeriesQuery({}, new Date("2026-10-18T22:30:00Z"));
  assert.deepEqual([parsed.from, parsed.to, parsed.granularity, parsed.keys.length], ["2026-09-20", "2026-10-19", "day", 30]);
  assert.equal(parsed.start.toISOString(), "2026-09-19T22:00:00.000Z");
  assert.equal(parsed.end.toISOString(), "2026-10-19T21:59:59.999Z");
});

test("granularity follows the range length unless requested", () => {
  assert.equal(parseTimeSeriesQuery({ from: "2026-01-01", to: "2026-03-03" }).granularity, "day");
  assert.equal(parseTimeSeriesQuery({ from: "2026-01-01", to: "2026-06-30" }).granularity, "week");
  assert.equal(parseTimeSeriesQuery({ from: "2024-01-01", to: "2026-06-30" }).granularity, "month");
  assert.equal(parseTimeSeriesQuery({ from: "2026-01-01", to: "2026-01-05", granularity: "month" }).granularity, "month");
});

test("time-series query rejects invalid input", () => {
  assert.throws(() => parseTimeSeriesQuery({ from: "2026-02-01", to: "2026-01-01" }), /before/);
  assert.throws(() => parseTimeSeriesQuery({ from: "2020-01-01", to: "2026-01-01", granularity: "day" }), /too long/);
  assert.throws(() => parseTimeSeriesQuery({ granularity: "minute" }), /granularity/);
  assert.throws(() => parseTimeSeriesQuery({ from: "2026-10-01", to: "2026-10-08", granularity: "hour" }), /too long/);
  assert.throws(() => parseTimeSeriesQuery({ from: "2026-02-30" }), /Invalid date/);
});

test("a single day is split into its 24 business hours", () => {
  const parsed = parseTimeSeriesQuery({ from: "2026-10-19", to: "2026-10-19" });
  assert.equal(parsed.granularity, "hour");
  assert.equal(parsed.keys.length, 24);
  assert.deepEqual([parsed.keys[0], parsed.keys[23]], ["2026-10-19T00", "2026-10-19T23"]);
  assert.deepEqual(bucketKeys("2026-12-31", "2027-01-01", "hour").slice(23, 25), ["2026-12-31T23", "2027-01-01T00"]);
  assert.equal(parseTimeSeriesQuery({ from: "2026-10-18", to: "2026-10-19" }).granularity, "day");
  const sales = JSON.stringify(saleSeriesPipeline(["CLOTHES"], { $gte: new Date(0), $lte: new Date() }, "hour"));
  assert.match(sales, /%Y-%m-%dT%H/);
  assert.match(sales, /Africa\/Lubumbashi/);
});

test("weeks start on Monday and months on the first day", () => {
  assert.deepEqual(bucketKeys("2026-09-10", "2026-09-21", "week"), ["2026-09-07", "2026-09-14", "2026-09-21"]);
  assert.deepEqual(bucketKeys("2026-11-15", "2027-01-02", "month"), ["2026-11-01", "2026-12-01", "2027-01-01"]);
});

test("the series uses the accounting recognition rule and snapshot amounts", () => {
  const range = { $gte: new Date(0), $lte: new Date() };
  const sales = JSON.stringify(saleSeriesPipeline(["CLOTHES"], range, "day"));
  assert.match(sales, /"status":"completed"/);
  assert.match(sales, /"completedAt"/);
  assert.match(sales, /\$items\.revenue/);
  assert.match(sales, /\$items\.costOfGoodsSold/);
  assert.doesNotMatch(sales, /"from":"products"/);
  const expenses = JSON.stringify(companyExpenseSeriesPipeline(["CLOTHES"], range, "week"));
  assert.match(expenses, /"expenseType":"COMPANY_EXPENSE"/);
  assert.match(expenses, /"status":"validated"/);
  assert.match(expenses, /REVERSAL/);
});
