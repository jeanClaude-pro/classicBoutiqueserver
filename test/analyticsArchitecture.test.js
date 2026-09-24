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

const accountingService = fs.readFileSync(
  path.join(__dirname, "../services/financialAccountingService.js"),
  "utf8"
);

// Category profitability is aggregated once, in financialAccountingService;
// Analytics consumes that DTO instead of keeping a second formula.
test("profitability is aggregated from immutable sale-item snapshots without Product lookups", () => {
  assert.match(serverAnalytics, /buildCategoryReport/);
  assert.match(accountingService, /\$unwind: "\$items"/);
  assert.match(accountingService, /items\.costOfGoodsSold/);
  assert.match(accountingService, /items\.mainCategory/);
  for (const source of [serverAnalytics, accountingService]) {
    assert.doesNotMatch(source, /\$lookup[\s\S]*from:\s*["']products["']/);
  }
});

test("shareholder amounts are derived after company expenses by the single accounting formula", () => {
  assert.match(accountingService, /function calculateCategoryAccounting/);
  assert.match(accountingService, /splitShoesProfit/);
  assert.doesNotMatch(serverAnalytics, /calculateCategoryAccounting|\$divide/);
});

test("historical FC profitability never uses the current exchange-rate endpoint", () => {
  assert.match(accountingService, /\$items\.exchangeRate/);
  assert.match(accountingService, /\$exchangeRate/);
  assert.doesNotMatch(accountingService, /getFallbackExchangeRate|ExchangeRate/);
  assert.doesNotMatch(clientAnalytics, /exchange-rates\/current/);
});
