const DISCOUNT_QUANTITY_THRESHOLD = 5;

class DiscountValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DiscountValidationError";
    this.code = code;
  }
}

function toCents(value, fieldName) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new TypeError(`${fieldName} must be a finite number`);
  return Math.round(amount * 100);
}

function totalPhysicalQuantity(items = []) {
  return items.reduce((total, item) => {
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new RangeError("quantity must be a positive integer");
    }
    return total + quantity;
  }, 0);
}

const isAmount = (value) =>
  value !== null && value !== undefined && Number.isFinite(Number(value));

// Tolerance for binary floating point only (a millionth of a cent); it can
// never admit a price that is genuinely below the floor.
const FLOOR_EPSILON_CENTS = 1e-6;

// Discount boundaries are calculated per unit in USD cents. For an odd-cent
// original profit, ceil keeps at least half of that profit instead of leaking
// half a cent through floating point rounding.
//
// An FC entry is compared with the FC reference in whole francs, so the
// normal FC price is never mistaken for a one-cent discount by conversion
// rounding. The floor itself is always checked on the unrounded USD value:
// an FC price worth $14.9965 does not pass a $15.00 floor.
function validateUnitSellingPrice({
  actualUnitPrice,
  referenceUnitPrice,
  unitAcquisitionCost,
  cartQuantity,
  actualUnitPriceFC,
  referenceUnitPriceFC,
}) {
  const actualCents = toCents(actualUnitPrice, "actualUnitPrice");
  const referenceCents = toCents(referenceUnitPrice, "referenceUnitPrice");
  const costCents = toCents(unitAcquisitionCost, "unitAcquisitionCost");
  const comparesFC = isAmount(actualUnitPriceFC) && isAmount(referenceUnitPriceFC);
  const discountApplied = comparesFC
    ? Number(actualUnitPriceFC) < Number(referenceUnitPriceFC)
    : actualCents < referenceCents;

  if (discountApplied && cartQuantity < DISCOUNT_QUANTITY_THRESHOLD) {
    throw new DiscountValidationError(
      "DISCOUNT_QUANTITY_REQUIRED",
      "La remise exige au moins 5 pièces dans le panier."
    );
  }

  const originalProfitCents = Math.max(0, referenceCents - costCents);
  const minimumAllowedCents = Math.max(
    costCents,
    costCents + Math.ceil(originalProfitCents / 2)
  );

  if (Number(actualUnitPrice) * 100 < minimumAllowedCents - FLOOR_EPSILON_CENTS) {
    throw new DiscountValidationError(
      "PRICE_TOO_LOW",
      "Prix trop bas. Veuillez augmenter le prix."
    );
  }

  const result = {
    discountApplied,
    referenceUnitSellingPrice: referenceCents / 100,
    discountPerUnit: discountApplied
      ? Math.max(0, referenceCents - actualCents) / 100
      : 0,
  };
  if (comparesFC) {
    result.discountPerUnitFC = discountApplied
      ? Number(referenceUnitPriceFC) - Number(actualUnitPriceFC)
      : 0;
  }
  return result;
}

module.exports = {
  DISCOUNT_QUANTITY_THRESHOLD,
  DiscountValidationError,
  totalPhysicalQuantity,
  validateUnitSellingPrice,
};
