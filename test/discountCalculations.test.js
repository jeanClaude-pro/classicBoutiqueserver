const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DiscountValidationError,
  totalPhysicalQuantity,
  validateUnitSellingPrice,
} = require("../utils/discountCalculations");
const { calculateProfitSnapshot } = require("../utils/profitCalculations");

const validate = (actualUnitPrice, referenceUnitPrice = 20, unitAcquisitionCost = 10, cartQuantity = 5) =>
  validateUnitSellingPrice({ actualUnitPrice, referenceUnitPrice, unitAcquisitionCost, cartQuantity });

test("discount eligibility counts physical units across every cart shape", () => {
  assert.equal(totalPhysicalQuantity([{ quantity: 5 }]), 5);
  assert.equal(totalPhysicalQuantity([{ quantity: 1 }, { quantity: 1 }, { quantity: 1 }, { quantity: 1 }, { quantity: 1 }]), 5);
  assert.equal(totalPhysicalQuantity([{ quantity: 3 }, { quantity: 2 }]), 5);
  assert.equal(totalPhysicalQuantity([{ quantity: 4 }]), 4);
});

test("quantity four rejects a discount while quantity five allows it", () => {
  assert.throws(
    () => validate(19, 20, 10, 4),
    (error) => error instanceof DiscountValidationError && error.code === "DISCOUNT_QUANTITY_REQUIRED"
  );
  assert.equal(validate(19, 20, 10, 5).discountApplied, true);
});

test("the exact 50% profit boundary is allowed and one cent below is rejected", () => {
  assert.deepEqual(validate(15), {
    discountApplied: true,
    referenceUnitSellingPrice: 20,
    discountPerUnit: 5,
  });
  assert.throws(
    () => validate(14.99),
    (error) => error.code === "PRICE_TOO_LOW" && !error.message.includes("15")
  );
});

test("a selling price below acquisition cost is rejected without exposing the floor", () => {
  assert.throws(
    () => validate(9, 20, 10),
    (error) => error.code === "PRICE_TOO_LOW" && error.message === "Prix trop bas. Veuillez augmenter le prix."
  );
});

test("each product has an independent per-unit boundary", () => {
  assert.equal(validate(15, 20, 10).discountApplied, true);
  assert.throws(() => validate(15, 40, 10), /Prix trop bas/);
});

test("quantity never multiplies the per-unit discount boundary", () => {
  assert.equal(validate(15, 20, 10, 500).discountPerUnit, 5);
  assert.throws(() => validate(14.99, 20, 10, 500), /Prix trop bas/);
});

test("discounted revenue, COGS, gross profit and ownership allocations use the actual price", () => {
  const clothes = calculateProfitSnapshot({ unitSellingPrice: 15, unitAcquisitionCost: 10, quantity: 5, mainCategory: "CLOTHES" });
  assert.deepEqual(
    [clothes.revenue, clothes.costOfGoodsSold, clothes.grossProfit, clothes.clothesShareholderProfit],
    [75, 50, 25, 25]
  );
  const shoes = calculateProfitSnapshot({ unitSellingPrice: 15, unitAcquisitionCost: 10, quantity: 5, mainCategory: "SHOES" });
  assert.deepEqual(
    [shoes.revenue, shoes.costOfGoodsSold, shoes.grossProfit, shoes.shoeShareholder1Profit, shoes.shoeShareholder2Profit],
    [75, 50, 25, 12.5, 12.5]
  );
});

test("pathological products cannot be discounted into a loss", () => {
  assert.throws(() => validate(9.99, 9, 10), /Prix trop bas/);
  assert.equal(validate(10, 9, 10).discountApplied, false);
});


const validateFC = (actualFC, referenceFC, rate, unitAcquisitionCost, cartQuantity = 5, referenceUSD = referenceFC / rate) =>
  validateUnitSellingPrice({
    actualUnitPrice: actualFC / rate,
    referenceUnitPrice: referenceUSD,
    unitAcquisitionCost,
    cartQuantity,
    actualUnitPriceFC: actualFC,
    referenceUnitPriceFC: referenceFC,
  });

test("an FC price equal to the normal FC price is never a discount, even when cents round down", () => {
  // $7.00501 is 701 cents; its FC equivalent (19,964 FC) converts back to
  // 700.49 cents. Compared in USD cents it would look like a one-cent
  // discount and a single-piece sale would be refused.
  const result = validateFC(19964, 19964, 2850, 3, 1, 7.00501);
  assert.equal(result.discountApplied, false);
  assert.equal(result.discountPerUnitFC, 0);
});

test("a discounted FC unit price keeps its exact FC discount per unit", () => {
  const result = validateFC(18000, 20000, 2850, 10000 / 2850);
  assert.equal(result.discountApplied, true);
  assert.equal(result.discountPerUnitFC, 2000);
});

test("an FC price worth a fraction of a cent below the floor is rejected", () => {
  // cost $10, normal $20 -> floor $15.00 = 42,750 FC at 2,850.
  assert.equal(validateFC(42750, 57000, 2850, 10).discountApplied, true);
  assert.throws(() => validateFC(42749, 57000, 2850, 10), (error) => error.code === "PRICE_TOO_LOW");
  assert.throws(() => validateFC(42740, 57000, 2850, 10), (error) => error.code === "PRICE_TOO_LOW");
});

test("a sub-cent USD entry below the floor is rejected rather than rounded up to it", () => {
  assert.throws(() => validate(14.999), (error) => error.code === "PRICE_TOO_LOW");
  assert.equal(validate(15.0).discountApplied, true);
});

test("prices at or above the normal price stay valid whatever the cart size (regression)", () => {
  assert.equal(validate(20, 20, 10, 1).discountApplied, false);
  assert.equal(validate(25, 20, 10, 1).discountApplied, false);
  assert.equal(validate(20, 20, 10, 1).discountPerUnit, 0);
});
