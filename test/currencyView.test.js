// FC-only cutover: historical (pre-cutover) records are presented in FC from
// their own snapshots; FC records pass through unchanged.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fcSale, fcExpense, fcEntry, fcLoan, fcProduct, productPriceFC, productUnitCostFC,
  saleFCStages, withCurrencyStages,
} = require("../utils/currency");

const usdSale = {
  type: "sale", status: "completed", exchangeRate: 2800, total: 30, subtotal: 30, totalRevenue: 30,
  costOfGoodsSold: 20, grossProfit: 10, shopProfit: 10, partnerProfit: 0,
  items: [{
    quantity: 3, price: 10, priceUSD: 10, enteredPrice: 10, enteredCurrency: "USD", exchangeRate: 2800,
    unitSellingPrice: 10, unitAcquisitionCost: 20 / 3, revenue: 30, costOfGoodsSold: 20, grossProfit: 10,
    mainCategory: "CLOTHES", clothesShareholderProfit: 10, shopProfit: 10, partnerProfit: 0,
    referenceUnitSellingPrice: 10, discountPerUnit: 0,
  }],
};

test("a USD-era sale is read at its OWN rate, and no dollar field remains", () => {
  const view = fcSale(structuredClone(usdSale));
  assert.equal(view.currency, "FC");
  assert.equal(view.total, 84000);
  assert.equal(view.totalRevenue, 84000);
  assert.equal(view.costOfGoodsSold, 56000);
  assert.equal(view.grossProfit, 28000);
  const [item] = view.items;
  assert.deepEqual([item.price, item.revenue, item.costOfGoodsSold, item.grossProfit, item.enteredCurrency], [28000, 84000, 56000, 28000, "FC"]);
  assert.equal(item.clothesShareholderProfit, 28000);
  assert.equal("exchangeRate" in view || "exchangeRate" in item || "priceUSD" in item, false);
});

test("an FC snapshot recorded before the cutover is used exactly", () => {
  const view = fcSale({
    type: "sale", exchangeRate: 2850, total: 14.04, totalRevenueFC: 40000, costOfGoodsSoldFC: 19950,
    items: [{ quantity: 2, price: 7.0175, enteredPrice: 20000, enteredCurrency: "FC", exchangeRate: 2850, revenue: 14.04, revenueFC: 40000, costOfGoodsSold: 7, costOfGoodsSoldFC: 19950, mainCategory: "SHOES" }],
  });
  assert.equal(view.total, 40000, "never 14.04 x a later rate");
  assert.equal(view.items[0].price, 20000);
  assert.equal(view.items[0].shoeShareholder1Profit, (40000 - 19950) / 2);
});

test("an FC record is returned unchanged", () => {
  const sale = { currency: "FC", total: 40000, items: [{ price: 20000, quantity: 2, revenue: 40000 }] };
  assert.equal(fcSale(sale), sale);
  const expense = { currency: "FC", amount: 5000 };
  assert.equal(fcExpense(expense), expense);
});

test("presenting a record twice changes nothing", () => {
  const once = fcSale(structuredClone(usdSale));
  assert.deepEqual(fcSale(structuredClone(once)), once);
});

test("cash entries, expenses and loans use their FC snapshot, else their own rate", () => {
  assert.equal(fcEntry({ amount: 100, amountFC: 280000, exchangeRate: 2800 }).amount, 280000);
  assert.equal(fcEntry({ amount: 3, enteredAmount: 9000, enteredCurrency: "FC", exchangeRate: 3000 }).amount, 9000);
  assert.equal(fcEntry({ amount: 10, exchangeRate: 2500 }).amount, 25000);
  assert.equal(fcEntry({ amount: 10 }).amount, undefined, "no rate: nothing is invented");
  assert.equal(fcLoan({ amountUSD: 10, amountFC: 28000, exchangeRate: 2800 }).amountFC, 28000);
  assert.equal("amountUSD" in fcLoan({ amountUSD: 10, amountFC: 28000 }), false);
});

test("an expense snapshot keeps capital + profit equal to its FC amount", () => {
  const view = fcExpense({
    amount: 100, amountFC: 280000, exchangeRate: 2800,
    financialSnapshot: { capitalUsed: 60, profitUsed: 40, profitUsedFC: 112000, availableBefore: 500 },
  });
  assert.equal(view.amount, 280000);
  assert.equal(view.financialSnapshot.profitUsed, 112000);
  assert.equal(view.financialSnapshot.capitalUsed, 168000);
  assert.equal(view.financialSnapshot.availableBefore, 1400000);
});

test("products are read in FC", () => {
  assert.equal(productPriceFC({ price: 7.0175, priceEnteredAmount: 20000, priceEnteredCurrency: "FC" }), 20000);
  assert.equal(productPriceFC({ price: 20, priceFC: 57000, priceExchangeRate: 2850 }), 57000);
  assert.equal(productPriceFC({ currency: "FC", price: 25000 }), 25000);
  assert.equal(productUnitCostFC({ unitCost: 10, unitCostExchangeRate: 2850 }), 28500);
  const view = fcProduct({ price: 20, priceFC: 57000, unitCost: 10, unitCostFC: 28500, purchasedQuantity: 4, totalAcquisitionCost: 40, priceExchangeRate: 2850, unitCostExchangeRate: 2850 });
  assert.deepEqual([view.price, view.unitCost, view.totalAcquisitionCost, view.currency], [57000, 28500, 114000, "FC"]);
  assert.equal("priceExchangeRate" in view, false);
});

test("FC stages are inserted after the leading $match stages, once", () => {
  const pipeline = [{ $match: { status: "completed" } }, { $match: { type: "sale" } }, { $group: { _id: null } }];
  withCurrencyStages(pipeline, saleFCStages());
  withCurrencyStages(pipeline, saleFCStages());
  assert.equal(pipeline.length, 3 + saleFCStages().length);
  assert.deepEqual(pipeline.slice(0, 2), [{ $match: { status: "completed" } }, { $match: { type: "sale" } }]);
  assert.ok(pipeline[2].$set.items);
  assert.deepEqual(pipeline.at(-1), { $group: { _id: null } });
});
