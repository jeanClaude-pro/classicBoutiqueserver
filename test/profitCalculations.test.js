const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  calculateProfitSnapshot,
  calculateTotalAcquisitionValue,
  sumFinancialSnapshots,
} = require("../utils/profitCalculations");
const { normalizeSaleItemPricing } = require("../utils/salePricing");

test("calculates the total acquisition value from the per-piece cost", () => {
  // 10 pieces x $5/piece acquisition cost = $50 total stock acquisition value.
  assert.equal(calculateTotalAcquisitionValue(5, 10), 50);
  // 25 pieces x $8/piece acquisition cost = $200 total stock acquisition value.
  assert.equal(calculateTotalAcquisitionValue(8, 25), 200);
  assert.equal(calculateTotalAcquisitionValue(10, 3), 30);
  assert.throws(() => calculateTotalAcquisitionValue(20, 0), /positive integer/);
  assert.throws(() => calculateTotalAcquisitionValue(20, 1.5), /positive integer/);
});

test("allocates all clothes profit to the single clothes shareholder", () => {
  assert.deepEqual(
    calculateProfitSnapshot({
      unitSellingPrice: 35,
      unitAcquisitionCost: 20,
      quantity: 1,
      mainCategory: "CLOTHES",
    }),
    {
      unitSellingPrice: 35,
      unitAcquisitionCost: 20,
      quantity: 1,
      revenue: 35,
      costOfGoodsSold: 20,
      grossProfit: 15,
      clothesShareholderProfit: 15,
      shoeShareholder1Profit: 0,
      shoeShareholder2Profit: 0,
      shareholderAllocationRule: "CLOTHES_OWNER_100",
      shopProfit: 15,
      partnerProfit: 0,
      mainCategory: "CLOTHES",
      profitAllocationRule: "SHOP_100",
    }
  );
});

test("splits only shoes profit, never revenue or invested capital", () => {
  const result = calculateProfitSnapshot({
    unitSellingPrice: 35,
    unitAcquisitionCost: 20,
    quantity: 1,
    mainCategory: "SHOES",
  });
  assert.equal(result.revenue, 35);
  assert.equal(result.costOfGoodsSold, 20);
  assert.equal(result.grossProfit, 15);
  assert.equal(result.clothesShareholderProfit, 0);
  assert.equal(result.shoeShareholder1Profit, 7.5);
  assert.equal(result.shoeShareholder2Profit, 7.5);
  assert.equal(result.shopProfit, 7.5);
  assert.equal(result.partnerProfit, 7.5);
  assert.equal(result.profitAllocationRule, "SHOES_50_50");
});

test("uses the actual discounted/custom selling price and supports a loss", () => {
  const result = calculateProfitSnapshot({
    unitSellingPrice: 18,
    unitAcquisitionCost: 20,
    quantity: 2,
    mainCategory: "SHOES",
  });
  assert.equal(result.revenue, 36);
  assert.equal(result.costOfGoodsSold, 40);
  assert.equal(result.grossProfit, -4);
  assert.equal(result.shoeShareholder1Profit, -2);
  assert.equal(result.shoeShareholder2Profit, -2);
  assert.equal(result.shopProfit, -2);
  assert.equal(result.partnerProfit, -2);
});

test("keeps shoe shareholder entitlements mathematically equal for a half-cent", () => {
  const result = calculateProfitSnapshot({
    unitSellingPrice: 10.01,
    unitAcquisitionCost: 10,
    quantity: 1,
    mainCategory: "SHOES",
  });
  assert.equal(result.shoeShareholder1Profit, 0.005);
  assert.equal(result.shoeShareholder2Profit, 0.005);
  assert.equal(result.shoeShareholder1Profit + result.shoeShareholder2Profit, result.grossProfit);
});

test("uses the USD snapshot produced from an FC custom price", () => {
  const pricing = normalizeSaleItemPricing(
    { enteredPrice: 10500, enteredCurrency: "FC" },
    3000
  );
  const result = calculateProfitSnapshot({
    unitSellingPrice: pricing.price,
    unitAcquisitionCost: 2,
    quantity: 2,
    mainCategory: "CLOTHES",
  });
  assert.equal(result.unitSellingPrice, 3.5);
  assert.equal(result.revenue, 7);
  assert.equal(result.grossProfit, 3);
});

test("aggregates immutable line snapshots without floating point drift", () => {
  const lines = [
    calculateProfitSnapshot({ unitSellingPrice: 0.1, unitAcquisitionCost: 0.03, quantity: 3, mainCategory: "CLOTHES" }),
    calculateProfitSnapshot({ unitSellingPrice: 0.2, unitAcquisitionCost: 0.1, quantity: 1, mainCategory: "SHOES" }),
  ];
  assert.deepEqual(sumFinancialSnapshots(lines), {
    clothesShareholderProfit: 0.21,
    shoeShareholder1Profit: 0.05,
    shoeShareholder2Profit: 0.05,
    totalRevenue: 0.5,
    costOfGoodsSold: 0.19,
    grossProfit: 0.31,
    shopProfit: 0.26,
    partnerProfit: 0.05,
  });
});

test("FC clothes example gives the clothes shareholder the full 6,000 FC gross profit", () => {
  const result = calculateProfitSnapshot({ unitSellingPrice: 8000, unitAcquisitionCost: 5000, quantity: 2, mainCategory: "CLOTHES" });
  assert.equal(result.revenue, 16000);
  assert.equal(result.costOfGoodsSold, 10000);
  assert.equal(result.grossProfit, 6000);
  assert.equal(result.clothesShareholderProfit, 6000);
  assert.equal(result.shoeShareholder1Profit, 0);
  assert.equal(result.shoeShareholder2Profit, 0);
});

test("FC shoes example splits only the 20,000 FC gross profit between two shareholders", () => {
  const result = calculateProfitSnapshot({ unitSellingPrice: 30000, unitAcquisitionCost: 20000, unitSellingPriceFC: 30000, unitAcquisitionCostFC: 20000, quantity: 2, mainCategory: "SHOES" });
  assert.equal(result.revenue, 60000);
  assert.equal(result.costOfGoodsSold, 40000);
  assert.equal(result.grossProfit, 20000);
  assert.equal(result.clothesShareholderProfit, 0);
  assert.equal(result.shoeShareholder1Profit, 10000);
  assert.equal(result.shoeShareholder2Profit, 10000);
  assert.equal(result.revenueFC, 60000);
  assert.equal(result.costOfGoodsSoldFC, 40000);
  assert.equal(result.grossProfitFC, 20000);
  assert.equal(result.shoeShareholder1ProfitFC, 10000);
  assert.equal(result.shoeShareholder2ProfitFC, 10000);
});

test("mixed clothes and shoes lines preserve isolated shareholder allocations", () => {
  const totals = sumFinancialSnapshots([
    calculateProfitSnapshot({ unitSellingPrice: 8, unitAcquisitionCost: 5, quantity: 2, mainCategory: "CLOTHES" }),
    calculateProfitSnapshot({ unitSellingPrice: 30, unitAcquisitionCost: 20, quantity: 2, mainCategory: "SHOES" }),
  ]);
  assert.equal(totals.grossProfit, 26);
  assert.equal(totals.clothesShareholderProfit, 6);
  assert.equal(totals.shoeShareholder1Profit, 10);
  assert.equal(totals.shoeShareholder2Profit, 10);
});

test("rejects invalid sale quantities and categories", () => {
  assert.throws(() => calculateProfitSnapshot({ unitSellingPrice: 1, unitAcquisitionCost: 1, quantity: 0, mainCategory: "CLOTHES" }), /positive integer/);
  assert.throws(() => calculateProfitSnapshot({ unitSellingPrice: 1, unitAcquisitionCost: 1, quantity: 1, mainCategory: "OTHER" }), /CLOTHES or SHOES/);
});

test("voided and refunded records cannot inflate recognized profit", () => {
  const salesRoute = fs.readFileSync(path.join(__dirname, "../routes/sales.js"), "utf8");
  const analyticsRoute = fs.readFileSync(path.join(__dirname, "../routes/analytics.js"), "utf8");
  assert.match(salesRoute, /\$eq: \["\$status", "completed"\][\s\S]{0,180}\$grossProfit/);
  assert.match(salesRoute, /status: "voided"/);
  assert.match(analyticsRoute, /status: \{ \$in: \["completed", "pending"\] \}/);
  assert.doesNotMatch(analyticsRoute, /VALID_SALE_MATCH[\s\S]{0,160}"refunded"/);
});
