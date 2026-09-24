const test = require("node:test");
const assert = require("node:assert/strict");
const { productNormalPrice, productPriceAuthority } = require("../utils/salePricing");
const { createDiscountProbeGuard } = require("../utils/discountProbeGuard");

const fcProduct = { price: 20000 / 2850, priceEnteredAmount: 20000, priceEnteredCurrency: "FC", priceFC: 20000, priceExchangeRate: 2850 };
const usdProduct = { price: 20, priceEnteredAmount: 20, priceEnteredCurrency: "USD", priceFC: 57000, priceExchangeRate: 2850 };

test("an FC-defined price keeps its exact FC amount at any rate; only USD follows", () => {
  assert.deepEqual(productNormalPrice(fcProduct, 2850), { currency: "FC", fc: 20000, usd: 20000 / 2850 });
  assert.deepEqual(productNormalPrice(fcProduct, 2900), { currency: "FC", fc: 20000, usd: 20000 / 2900 });
  assert.notEqual(productNormalPrice(fcProduct, 2900).fc, Math.round(fcProduct.price * 2900), "never 20,351 FC");
  // Without a rate the stored USD value is the only USD figure available.
  assert.deepEqual(productNormalPrice(fcProduct, undefined), { currency: "FC", fc: 20000, usd: fcProduct.price });
});

test("a USD-defined price keeps its exact USD amount; FC follows the rate", () => {
  assert.deepEqual(productNormalPrice(usdProduct, 2900), { currency: "USD", usd: 20, fc: 58000 });
  assert.deepEqual(productNormalPrice(usdProduct, 2950), { currency: "USD", usd: 20, fc: 59000 });
  assert.deepEqual(productNormalPrice(usdProduct, undefined), { currency: "USD", usd: 20, fc: undefined });
});

test("legacy and malformed products fall back to their USD price", () => {
  assert.deepEqual(productPriceAuthority({ price: 30 }), { currency: "USD", amount: 30 });
  assert.deepEqual(productPriceAuthority({ price: 7, priceEnteredCurrency: "FC" }), { currency: "USD", amount: 7 });
  // A priceFC without priceEnteredAmount (older FC record) is still exact.
  assert.deepEqual(productPriceAuthority({ price: 7, priceEnteredCurrency: "FC", priceFC: 20000 }), { currency: "FC", amount: 20000 });
});

test("the discount probe guard limits a user after repeated refusals, for one window only", () => {
  let clock = 0;
  const guard = createDiscountProbeGuard({ windowMs: 1000, maxRejections: 3, now: () => clock });
  assert.equal(guard.recordRejection("u1"), false);
  clock = 100;
  assert.equal(guard.recordRejection("u1"), false);
  assert.equal(guard.isLimited("u1"), false);
  clock = 200;
  assert.equal(guard.recordRejection("u1"), true, "the third refusal reaches the limit");
  assert.equal(guard.isLimited("u1"), true);
  assert.equal(guard.isLimited("u2"), false, "other users are unaffected");
  assert.equal(guard.isLimited(null), false, "exempt roles have no key");
  clock = 1001;
  assert.equal(guard.isLimited("u1"), false, "the oldest refusal left the window");
});
