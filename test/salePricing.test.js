const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CurrencyError,
  normalizeAmountSnapshot,
  normalizeSaleItemPricing,
} = require("../utils/salePricing");

test("a sale line is priced in FC exactly as entered", () => {
  const price = normalizeSaleItemPricing({ price: 12000, enteredPrice: 12000, enteredCurrency: "FC" });
  assert.deepEqual(price, { price: 12000, enteredPrice: 12000, enteredCurrency: "FC", priceFC: 12000 });
  assert.equal(normalizeSaleItemPricing({ enteredPrice: 12347, enteredCurrency: "FC" }).price * 3, 37041);
});

test("a line without a currency is FC; a client exchange rate is ignored", () => {
  const price = normalizeSaleItemPricing({ price: 7250, exchangeRate: 2850 });
  assert.deepEqual(price, { price: 7250, enteredPrice: 7250, enteredCurrency: "FC", priceFC: 7250 });
  assert.equal(price.exchangeRate, undefined);
});

test("a USD amount is refused instead of being converted", () => {
  assert.throws(() => normalizeSaleItemPricing({ enteredPrice: 10, enteredCurrency: "USD" }), CurrencyError);
  assert.throws(() => normalizeAmountSnapshot({ enteredAmount: 10, enteredCurrency: "USD" }), CurrencyError);
});

test("non-positive amounts are refused", () => {
  assert.throws(() => normalizeSaleItemPricing({ enteredPrice: 0, enteredCurrency: "FC" }), /positive/);
  assert.throws(() => normalizeAmountSnapshot({ amount: -5 }), /positive/);
});

test("entry and expense snapshots are FC only", () => {
  assert.deepEqual(normalizeAmountSnapshot({ enteredAmount: 36000, enteredCurrency: "FC", exchangeRate: 2850 }), {
    currency: "FC", amount: 36000, enteredAmount: 36000, enteredCurrency: "FC", amountFC: 36000,
  });
  assert.equal(normalizeAmountSnapshot({ amount: 5000 }).amount, 5000);
});
