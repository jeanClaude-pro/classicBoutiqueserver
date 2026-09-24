const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BASIS,
  calculateCategoryAccounting,
  purchaseSnapshot,
  projectAccounting,
  splitShoesProfit,
} = require("../services/financialAccountingService");

const cents = (value) => Math.round(value * 100);
const clothes = (input, options) => calculateCategoryAccounting({ category: "CLOTHES", ...input }, options);
const shoes = (input, options) => calculateCategoryAccounting({ category: "SHOES", ...input }, options);

// Every category result must satisfy the accounting identities exactly.
function assertIdentities(row) {
  assert.equal(cents(row.revenue) - cents(row.costOfGoodsSold), cents(row.grossProfit), "revenue - COGS = gross");
  assert.equal(cents(row.grossProfit) - cents(row.companyExpenses), cents(row.netProfit), "gross - expenses = net");
  assert.equal(cents(row.capitalUsedForPurchases) + cents(row.profitUsedForPurchases), cents(row.goodsPurchases), "capital + profit = purchases");
  assert.equal(cents(row.shareholder1) + cents(row.shareholder2), cents(row.distributableProfit), "shareholders = distributable");
  if (row.basis === BASIS.BALANCE) {
    assert.equal(cents(row.remainingRecoveredCapital) + cents(row.distributableProfit) * (row.category === "CLOTHES" ? 1 : 0), cents(row.availablePurchaseFunds));
    // Money can neither appear nor vanish: available - shortfall = resources - purchases.
    assert.equal(cents(row.availablePurchaseFunds) - cents(row.fundingShortfall), cents(row.generatedPurchaseFunds) - cents(row.goodsPurchases));
  }
}

test("SHOES recovered capital, not revenue, is the replenishment fund", () => {
  const row = shoes({ revenue: 1000, costOfGoodsSold: 600 });
  assertIdentities(row);
  assert.equal(row.grossProfit, 400);
  assert.equal(row.recoveredCapital, 600);
  assert.equal(row.availablePurchaseFunds, 600);
  assert.equal(row.distributableProfit, 400);
});

test("CLOTHES may reinvest recovered capital plus net profit", () => {
  const row = clothes({ revenue: 1000, costOfGoodsSold: 600, companyExpenses: 100 });
  assertIdentities(row);
  assert.equal(row.netProfit, 300);
  assert.equal(row.availablePurchaseFunds, 900);
});

test("CLOTHES $500 purchase consumes capital only and leaves profit intact", () => {
  const before = clothes({ revenue: 1000, costOfGoodsSold: 600, companyExpenses: 100 });
  const snapshot = purchaseSnapshot(before, 500);
  assert.equal(snapshot.fundingSource, "RECOVERED_CAPITAL");
  assert.deepEqual([snapshot.financialSnapshot.capitalUsed, snapshot.financialSnapshot.profitUsed], [500, 0]);
  const after = projectAccounting(before, { goodsPurchases: 500, capitalUsed: 500, profitUsed: 0 });
  assertIdentities(after);
  assert.equal(after.remainingRecoveredCapital, 100);
  assert.equal(after.distributableProfit, 300);
});

test("CLOTHES $700 purchase uses $600 capital then $100 profit", () => {
  const before = clothes({ revenue: 1000, costOfGoodsSold: 600, companyExpenses: 100 });
  const snapshot = purchaseSnapshot(before, 700);
  assert.equal(snapshot.fundingSource, "MIXED");
  assert.deepEqual([snapshot.financialSnapshot.capitalUsed, snapshot.financialSnapshot.profitUsed], [600, 100]);
  const after = projectAccounting(before, { goodsPurchases: 700, capitalUsed: 600, profitUsed: 100 });
  assertIdentities(after);
  assert.equal(after.distributableProfit, 200);
  assert.equal(after.profitUsedForPurchases, 100);
  assert.equal(after.availablePurchaseFunds, 200);
});

test("CLOTHES purchase above capital + profit is refused", () => {
  const row = clothes({ revenue: 1000, costOfGoodsSold: 600, companyExpenses: 100 });
  assert.throws(() => purchaseSnapshot(row, 900.01), (error) => {
    assert.equal(error.code, "INSUFFICIENT_PURCHASE_FUNDS");
    assert.deepEqual(error.details, { category: "CLOTHES", requested: 900.01, available: 900 });
    return true;
  });
});

test("SHOES purchase can never consume profit even when revenue looks sufficient", () => {
  const row = shoes({ revenue: 10000, costOfGoodsSold: 6000, goodsPurchases: 5500 });
  assertIdentities(row);
  assert.equal(row.availablePurchaseFunds, 500);
  assert.equal(row.distributableProfit, 4000);
  assert.throws(() => purchaseSnapshot(row, 700), (error) => {
    assert.equal(error.code, "INSUFFICIENT_PURCHASE_FUNDS");
    assert.deepEqual(error.details, { category: "SHOES", requested: 700, available: 500 });
    return true;
  });
  const exact = purchaseSnapshot(row, 500);
  assert.equal(exact.financialSnapshot.profitUsed, 0);
  assert.equal(exact.financialSnapshot.availableAfter, 0);
});

test("SHOES goods purchases never reduce SHOES shareholder profit", () => {
  const noPurchase = shoes({ revenue: 1000, costOfGoodsSold: 600, companyExpenses: 100 });
  const withPurchase = shoes({ revenue: 1000, costOfGoodsSold: 600, companyExpenses: 100, goodsPurchases: 500 });
  assert.equal(withPurchase.distributableProfit, noPurchase.distributableProfit);
  assert.equal(withPurchase.distributableProfit, 300);
  assert.equal(withPurchase.shareholder1 + withPurchase.shareholder2, 300);
});

test("CLOTHES expenses above gross profit report a real loss, not zero", () => {
  const row = clothes({ revenue: 900, costOfGoodsSold: 600, companyExpenses: 500 });
  assertIdentities(row);
  assert.equal(row.grossProfit, 300);
  assert.equal(row.netProfit, -200);
  assert.equal(row.distributableProfit, 0);
  assert.equal(row.shareholder1, 0);
  // The $200 loss was paid out of recovered capital: only $400 cash remains.
  assert.equal(row.lossCoveredByCapital, 200);
  assert.equal(row.availablePurchaseFunds, 400);
});

test("SHOES loss is never split into negative shareholder amounts", () => {
  const row = shoes({ revenue: 900, costOfGoodsSold: 600, companyExpenses: 500 });
  assertIdentities(row);
  assert.equal(row.netProfit, -200);
  assert.equal(row.distributableProfit, 0);
  assert.equal(row.shareholder1, 0);
  assert.equal(row.shareholder2, 0);
  assert.equal(row.availablePurchaseFunds, 400);
});

test("later profit first rebuilds capital consumed by an earlier loss", () => {
  // Loss month: gross 300, expenses 500. Next month: COGS 600, gross 400.
  const row = shoes({ revenue: 1900, costOfGoodsSold: 1200, companyExpenses: 500 });
  assertIdentities(row);
  assert.equal(row.netProfit, 200);
  assert.equal(row.availablePurchaseFunds, 1200);
  assert.equal(row.distributableProfit, 200);
});

test("reversing a company expense restores the net result exactly", () => {
  const before = clothes({ grossProfit: 1000, companyExpenses: 200 });
  assert.equal(before.netProfit, 800);
  const reversed = projectAccounting(before, { companyExpenses: -200 });
  assert.equal(reversed.netProfit, 1000);
});

test("reversing a validated purchase returns exactly its frozen funding", () => {
  const before = shoes({ revenue: 1666.67, costOfGoodsSold: 1000 });
  const snapshot = purchaseSnapshot(before, 600).financialSnapshot;
  const spent = projectAccounting(before, { goodsPurchases: 600, capitalUsed: snapshot.capitalUsed, profitUsed: snapshot.profitUsed });
  assert.equal(spent.availablePurchaseFunds, 400);
  const reversed = projectAccounting(spent, { goodsPurchases: -600, capitalUsed: -snapshot.capitalUsed, profitUsed: -snapshot.profitUsed });
  assert.equal(reversed.availablePurchaseFunds, 1000);
});

test("historical CLOTHES allocation stays frozen when more capital is recovered later", () => {
  // Validation day: capital 600, profit 400. Purchase 800 => 600 + 200.
  const day1 = clothes({ revenue: 1000, costOfGoodsSold: 600 });
  const frozen = purchaseSnapshot(day1, 800).financialSnapshot;
  assert.deepEqual([frozen.capitalUsed, frozen.profitUsed], [600, 200]);
  // Next day another 500 of capital is recovered; the purchase stays 600/200.
  const day2 = clothes({
    revenue: 1800, costOfGoodsSold: 1100, goodsPurchases: 800,
    capitalUsedForPurchases: frozen.capitalUsed, profitUsedForPurchases: frozen.profitUsed,
  });
  assertIdentities(day2);
  assert.equal(day2.profitUsedForPurchases, 200);
  assert.equal(day2.capitalUsedForPurchases, 600);
  assert.equal(day2.distributableProfit, 700 - 200);
  assert.equal(day2.remainingRecoveredCapital, 500);
});

test("a capital shortfall is exposed instead of being clamped away", () => {
  // Capital 600 was spent, then a sale worth COGS 300 / gross 200 was voided.
  const row = clothes({ revenue: 500, costOfGoodsSold: 300, goodsPurchases: 600, capitalUsedForPurchases: 600, profitUsedForPurchases: 0 });
  assertIdentities(row);
  assert.equal(row.availablePurchaseFunds, 0);
  assert.equal(row.fundingShortfall, 100);
  assert.equal(row.distributableProfit, 0, "CLOTHES profit covers the capital gap first");
  const shoe = shoes({ revenue: 500, costOfGoodsSold: 300, goodsPurchases: 600 });
  assertIdentities(shoe);
  assert.equal(shoe.fundingShortfall, 300, "SHOES capital gap is carried against future capital");
  assert.equal(shoe.distributableProfit, 200, "SHOES shareholder profit stays protected");
});

test("period basis never reports a spendable balance", () => {
  const period = clothes({ revenue: 200, costOfGoodsSold: 100, goodsPurchases: 500, capitalUsedForPurchases: 500, profitUsedForPurchases: 0 }, { basis: BASIS.PERIOD });
  assert.equal(period.availablePurchaseFunds, null);
  assert.equal(period.fundingShortfall, null);
  // Capital recovered in an earlier period financed this purchase: this
  // period's profit is still fully distributable.
  assert.equal(period.distributableProfit, 100);
  assert.throws(() => purchaseSnapshot(period, 1), /cumulative balance/);
});

test("odd cents are split deterministically without creating or losing money", () => {
  for (const total of [1, 5, 10, 999, 1099, 99999999]) {
    const { shareholder1, shareholder2 } = splitShoesProfit(total);
    assert.equal(shareholder1 + shareholder2, total);
    assert.ok(shareholder1 - shareholder2 === 0 || shareholder1 - shareholder2 === 1);
  }
  const row = shoes({ grossProfit: 0.05 });
  assert.deepEqual([row.shareholder1, row.shareholder2], [0.03, 0.02]);
});

test("small, awkward and large USD amounts stay exact in cents", () => {
  for (const amount of [0.01, 0.05, 0.1, 10.99, 999999.99]) {
    const row = shoes({ revenue: amount * 3, costOfGoodsSold: amount * 2, goodsPurchases: amount });
    assertIdentities(row);
    assert.equal(cents(row.availablePurchaseFunds), cents(amount * 2) - cents(amount));
  }
  const big = clothes({ revenue: 999999.99 * 10, costOfGoodsSold: 999999.99 * 6, companyExpenses: 0.01 });
  assertIdentities(big);
  assert.equal(big.netProfit, 3999999.95);
  assert.throws(() => purchaseSnapshot(shoes({ costOfGoodsSold: 1 }), 0.004), /at least 0.01/);
});

test("repeated 0.1 additions do not drift", () => {
  let row = clothes({ revenue: 100, costOfGoodsSold: 50 });
  for (let i = 0; i < 1000; i += 1) row = projectAccounting(row, { companyExpenses: 0.1 });
  assert.equal(row.companyExpenses, 100);
  assert.equal(row.netProfit, -50);
});
