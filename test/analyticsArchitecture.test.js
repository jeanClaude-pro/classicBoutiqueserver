const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const clientAnalytics = fs.readFileSync(
  path.join(__dirname, "../../client/src/pages/analytics/Analytics.tsx"),
  "utf8"
);
const serverAnalytics = fs.readFileSync(
  path.join(__dirname, "../routes/analytics.js"),
  "utf8"
);

test("Analytics frontend uses only the non-paginated aggregation endpoint", () => {
  assert.match(clientAnalytics, /\/analytics\/summary\?/);
  assert.doesNotMatch(clientAnalytics, /serverUrl}\/sales/);
  assert.doesNotMatch(clientAnalytics, /serverUrl}\/expenses/);
  assert.doesNotMatch(clientAnalytics, /serverUrl}\/entries/);
  assert.doesNotMatch(clientAnalytics, /serverUrl}\/customers/);
  assert.doesNotMatch(clientAnalytics, /\.reduce\(/);
});

test("Analytics backend aggregates every financial collection and declares no pagination", () => {
  assert.match(serverAnalytics, /Sale\.aggregate\(/);
  assert.match(serverAnalytics, /Entry\.aggregate\(/);
  assert.match(serverAnalytics, /Expense\.aggregate\(/);
  assert.match(serverAnalytics, /source: "mongodb-aggregation"/);
  assert.match(serverAnalytics, /paginated: false/);
  assert.doesNotMatch(serverAnalytics, /parsePagination|\$skip|\$limit: limit/);
});

test("profitability is aggregated from immutable sale-item snapshots without Product lookups", () => {
  assert.match(serverAnalytics, /profitMetrics:[\s\S]*?\$unwind: "\$items"/);
  assert.match(serverAnalytics, /categoryBreakdown:[\s\S]*?\$unwind: "\$items"/);
  assert.match(serverAnalytics, /items\.unitAcquisitionCost|items\.costOfGoodsSold/);
  assert.match(serverAnalytics, /items\.clothesShareholderProfit/);
  assert.match(serverAnalytics, /items\.shoeShareholder1Profit/);
  assert.match(serverAnalytics, /items\.shoeShareholder2Profit/);
  assert.doesNotMatch(serverAnalytics, /\$lookup[\s\S]*from:\s*["']products["']/);
});

test("historical FC profitability never uses the current exchange-rate endpoint", () => {
  assert.match(serverAnalytics, /\$items\.exchangeRate/);
  assert.match(serverAnalytics, /\$exchangeRate/);
  assert.doesNotMatch(clientAnalytics, /exchange-rates\/current/);
});
