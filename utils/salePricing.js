// Money input normalization. Since the FC-only cutover every amount the shop
// records is in Congolese francs: there is no second currency and no exchange
// rate. A request still carrying another currency (a till running an old
// version of the interface) is refused instead of being guessed at.
const { CURRENCY, productPriceFC } = require("./currency");

class CurrencyError extends Error {
  constructor(message) {
    super(message);
    this.name = "CurrencyError";
    this.code = "CURRENCY_NOT_SUPPORTED";
  }
}

function toPositiveNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }
  return number;
}

function assertFC(currency) {
  if (currency === undefined || currency === null || currency === "" || currency === CURRENCY) return;
  throw new CurrencyError(
    "L'application fonctionne uniquement en francs congolais (FC). Actualisez la page puis saisissez le montant en FC."
  );
}

// A sale line's unit price, in FC.
function normalizeSaleItemPricing(item) {
  assertFC(item?.enteredCurrency);
  const price = toPositiveNumber(item?.enteredPrice ?? item?.price, "price");
  return {
    price,
    enteredPrice: price,
    enteredCurrency: CURRENCY,
    priceFC: price,
  };
}

// The money fields of a cash entry, expense or loan, in FC.
function normalizeAmountSnapshot(input = {}) {
  assertFC(input.enteredCurrency);
  const amount = toPositiveNumber(input.enteredAmount ?? input.amount, "amount");
  return {
    currency: CURRENCY,
    amount,
    enteredAmount: amount,
    enteredCurrency: CURRENCY,
    amountFC: amount,
  };
}

// The Product's normal unit selling price for a new transaction, in FC.
// Recorded sales never call this: they keep their own snapshots.
function productNormalPrice(product) {
  return { currency: CURRENCY, fc: productPriceFC(product) };
}

module.exports = {
  CurrencyError,
  assertFC,
  normalizeAmountSnapshot,
  normalizeSaleItemPricing,
  productNormalPrice,
};
