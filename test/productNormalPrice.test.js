const test = require("node:test");
const assert = require("node:assert/strict");
const { productNormalPrice } = require("../utils/salePricing");
const { createDiscountProbeGuard } = require("../utils/discountProbeGuard");

// Since the FC-only cutover the normal price is the product's FC price.
test("an FC product's normal price is its exact FC price", () => {
  assert.deepEqual(productNormalPrice({ currency: "FC", price: 20000, priceFC: 20000 }), { currency: "FC", fc: 20000 });
});

test("a pre-cutover product is read in FC through its own FC snapshot, never a new rate", () => {
  // Defined in FC: the entered FC amount stays exact.
  const fcDefined = { price: 20000 / 2850, priceEnteredAmount: 20000, priceEnteredCurrency: "FC", priceFC: 20000, priceExchangeRate: 2850 };
  assert.equal(productNormalPrice(fcDefined).fc, 20000);
  // Defined in USD: its FC snapshot, else its USD price at its own stored rate.
  assert.equal(productNormalPrice({ price: 20, priceEnteredCurrency: "USD", priceFC: 57000, priceExchangeRate: 2850 }).fc, 57000);
  assert.equal(productNormalPrice({ price: 20, priceExchangeRate: 2900 }).fc, 58000);
  // No FC information at all: no invented price.
  assert.equal(productNormalPrice({ price: 30 }).fc, undefined);
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
