const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  calculateCategoryAccounting,
  purchaseSnapshot,
  EXPENSE_TYPES,
} = require("../services/financialAccountingService");

test("CLOTHES company expense reduces net and distributable profit once", () => {
  const row = calculateCategoryAccounting({ category: "CLOTHES", grossProfit: 1000, companyExpenses: 200 });
  assert.equal(row.netProfit, 800);
  assert.equal(row.distributableProfit, 800);
  assert.equal(row.shareholder1, 800);
});

test("SHOES company expense is deducted before the equal shareholder split", () => {
  const row = calculateCategoryAccounting({ category: "SHOES", grossProfit: 1000, companyExpenses: 200 });
  assert.equal(row.netProfit, 800);
  assert.equal(row.shareholder1, 400);
  assert.equal(row.shareholder2, 400);
});

test("SHOES purchase capacity contains recovered capital but excludes profit", () => {
  const row = calculateCategoryAccounting({ category: "SHOES", revenue: 1000, costOfGoodsSold: 600, grossProfit: 400 });
  assert.equal(row.availablePurchaseFunds, 600);
  assert.equal(row.distributableProfit, 400);
});

test("CLOTHES purchase capacity combines recovered capital and net profit", () => {
  const row = calculateCategoryAccounting({ category: "CLOTHES", revenue: 1000, costOfGoodsSold: 600, grossProfit: 400, companyExpenses: 100 });
  assert.equal(row.availablePurchaseFunds, 900);
});

test("previous validated purchases cannot spend the same generated funds twice", () => {
  const row = calculateCategoryAccounting({ category: "CLOTHES", costOfGoodsSold: 6000, grossProfit: 4000, goodsPurchases: 6000 });
  assert.equal(row.availablePurchaseFunds, 4000);
  assert.equal(purchaseSnapshot(row, 2500).financialSnapshot.availableAfter, 1500);
});

test("insufficient purchase funds produce the structured accounting error", () => {
  const row = calculateCategoryAccounting({ category: "SHOES", costOfGoodsSold: 1800, grossProfit: 700 });
  assert.throws(() => purchaseSnapshot(row, 2500), (error) => {
    assert.equal(error.code, "INSUFFICIENT_PURCHASE_FUNDS");
    assert.deepEqual(error.details, { category: "SHOES", requested: 2500, available: 1800 });
    return true;
  });
});

test("CLOTHES funding allocation consumes capital before profit", () => {
  const row = calculateCategoryAccounting({ category: "CLOTHES", costOfGoodsSold: 600, grossProfit: 400 });
  const snapshot = purchaseSnapshot(row, 750);
  assert.equal(snapshot.fundingSource, "MIXED");
  assert.equal(snapshot.financialSnapshot.capitalUsed, 600);
  assert.equal(snapshot.financialSnapshot.profitUsed, 150);
  const after = calculateCategoryAccounting({ category: "CLOTHES", costOfGoodsSold: 600, grossProfit: 400, goodsPurchases: 750 });
  assert.equal(after.distributableProfit, 250);
});

test("SHOES purchases can never receive a profit allocation", () => {
  const row = calculateCategoryAccounting({ category: "SHOES", costOfGoodsSold: 600, grossProfit: 400 });
  const snapshot = purchaseSnapshot(row, 600);
  assert.equal(snapshot.fundingSource, "RECOVERED_CAPITAL");
  assert.equal(snapshot.financialSnapshot.profitUsed, 0);
});

test("money calculations round through integer cents", () => {
  const row = calculateCategoryAccounting({ category: "SHOES", grossProfit: 10.01, companyExpenses: 0.02 });
  assert.equal(row.netProfit, 9.99);
  // Payable amounts are whole cents; the odd cent goes to shareholder 1 and
  // the two shares always add up to the distributable total exactly.
  assert.equal(row.shareholder1, 5);
  assert.equal(row.shareholder2, 4.99);
  assert.equal(Math.round(row.shareholder1 * 100) + Math.round(row.shareholder2 * 100), Math.round(row.distributableProfit * 100));
});

test("only validated explicit accounting types participate in authoritative aggregation", () => {
  const source = fs.readFileSync(path.join(__dirname, "../services/financialAccountingService.js"), "utf8");
  assert.match(source, /status: "validated"/);
  assert.match(source, /expenseType: \{ \$in: \[EXPENSE_TYPES\.COMPANY, EXPENSE_TYPES\.GOODS\] \}/);
  assert.equal(EXPENSE_TYPES.LEGACY, "LEGACY_UNCLASSIFIED");
});

test("validation takes a category write lock before calculating available funds", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/expenses.js"), "utf8");
  const lockAt = source.indexOf("await acquireAccountingLock");
  const aggregateAt = source.indexOf("await aggregateCategoryAccounting", lockAt);
  assert.ok(lockAt > 0 && aggregateAt > lockAt);
  assert.match(source, /session\.withTransaction/);
});

test("financial endpoints enforce roles and server-side today scoping", () => {
  const expenses = fs.readFileSync(path.join(__dirname, "../routes/expenses.js"), "utf8");
  const analytics = fs.readFileSync(path.join(__dirname, "../routes/analytics.js"), "utf8");
  const sales = fs.readFileSync(path.join(__dirname, "../routes/sales.js"), "utf8");
  assert.match(expenses, /requireRole\("superadmin", "manager", "inventory_manager", "cashier_supervisor"\)/);
  assert.match(analytics, /requireRole\("superadmin", "admin"\)/);
  for (const source of [expenses, analytics, sales]) {
    assert.match(source, /visibleTimeframeQuery/);
    assert.match(source, /\["admin", "superadmin"\]/);
  }
});
