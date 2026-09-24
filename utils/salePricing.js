const SUPPORTED_CURRENCIES = new Set(["USD", "FC"]);

function toPositiveNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }
  return number;
}

function normalizeExchangeRate(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return toPositiveNumber(value, "exchangeRate");
}

// The single authoritative FC<->USD formula. Every caller (sale items, cash
// entries/expenses, product pricing) funnels through this one function so
// there is exactly one place that defines "FC = USD * rate". The entered
// currency's value is always kept exact; only the other currency is derived.
function convertEnteredAmount(enteredAmount, enteredCurrency, exchangeRate) {
  const amountUSD =
    enteredCurrency === "USD" ? enteredAmount : enteredAmount / exchangeRate;
  const amountFC =
    enteredCurrency === "FC"
      ? enteredAmount
      : exchangeRate
        ? Math.round(enteredAmount * exchangeRate)
        : undefined;
  return { amountUSD, amountFC };
}

function normalizeSaleItemPricing(item, saleExchangeRate) {
  const hasOriginalPricing =
    item.enteredPrice !== undefined || item.enteredCurrency !== undefined;

  if (!hasOriginalPricing) {
    return { price: toPositiveNumber(item.price, "price") };
  }

  if (!SUPPORTED_CURRENCIES.has(item.enteredCurrency)) {
    throw new Error("enteredCurrency must be USD or FC");
  }

  const enteredPrice = toPositiveNumber(item.enteredPrice, "enteredPrice");
  const exchangeRate = normalizeExchangeRate(
    item.exchangeRate ?? saleExchangeRate
  );

  if (item.enteredCurrency === "FC" && !exchangeRate) {
    throw new Error("exchangeRate is required for an FC price");
  }

  // The entered currency is authoritative. Only the other currency is derived.
  const { amountUSD: priceUSD, amountFC: priceFC } = convertEnteredAmount(
    enteredPrice,
    item.enteredCurrency,
    exchangeRate
  );

  return {
    price: priceUSD,
    enteredPrice,
    enteredCurrency: item.enteredCurrency,
    priceUSD,
    priceFC,
    exchangeRate,
  };
}

function normalizeAmountSnapshot(input, fallbackExchangeRate) {
  const enteredCurrency = input.enteredCurrency || "USD";
  if (!SUPPORTED_CURRENCIES.has(enteredCurrency)) {
    throw new Error("enteredCurrency must be USD or FC");
  }

  const enteredAmount = toPositiveNumber(
    input.enteredAmount ?? input.amount,
    "enteredAmount"
  );
  const exchangeRate = normalizeExchangeRate(
    input.exchangeRate ?? fallbackExchangeRate
  );

  if (enteredCurrency === "FC" && !exchangeRate) {
    throw new Error("exchangeRate is required for an FC amount");
  }

  const { amountUSD, amountFC } = convertEnteredAmount(
    enteredAmount,
    enteredCurrency,
    exchangeRate
  );

  return {
    amount: amountUSD,
    enteredAmount,
    enteredCurrency,
    amountUSD,
    amountFC,
    exchangeRate,
  };
}

// The currency in which a Product's normal selling price was defined is
// authoritative (priceEnteredCurrency + priceEnteredAmount). Products saved
// before those fields existed only ever had the USD `price`, so they are
// USD-authoritative. A malformed FC record without an FC amount falls back to
// its USD price rather than inventing one.
function productPriceAuthority(product) {
  if (product?.priceEnteredCurrency === "FC") {
    const fc = Number(product.priceEnteredAmount ?? product.priceFC);
    if (Number.isFinite(fc) && fc > 0) return { currency: "FC", amount: fc };
  }
  const usd = Number(
    product?.priceEnteredCurrency === "USD" ? product.priceEnteredAmount ?? product.price : product?.price
  );
  return { currency: "USD", amount: usd };
}

// The Product's normal unit price for a NEW transaction at `rate`. The
// authoritative amount is used exactly and only the other currency follows
// the rate: 20,000 FC stays 20,000 FC (USD = 20,000 / rate), $20 stays $20
// (FC = 20 x rate). The FC amount is never rebuilt from a USD value saved at
// an older rate. Recorded sales never call this: they keep their snapshots.
function productNormalPrice(product, rate) {
  const { currency, amount } = productPriceAuthority(product);
  const validRate = Number(rate) > 0 ? Number(rate) : undefined;
  if (currency === "FC") {
    return { currency, fc: amount, usd: validRate ? amount / validRate : Number(product.price) };
  }
  return { currency, usd: amount, fc: validRate ? Math.round(amount * validRate) : undefined };
}

// productNormalPrice(...).usd as an aggregation expression over Product
// documents, for current catalogue valuations (inventory retail value), never
// for recorded sales.
function productNormalPriceUSDExpression(rate) {
  const validRate = Number(rate) > 0 ? Number(rate) : undefined;
  if (!validRate) return "$price";
  const fcAmount = { $ifNull: ["$priceEnteredAmount", "$priceFC"] };
  return {
    $cond: [
      { $and: [{ $eq: ["$priceEnteredCurrency", "FC"] }, { $gt: [fcAmount, 0] }] },
      { $divide: [fcAmount, validRate] },
      { $cond: [{ $eq: ["$priceEnteredCurrency", "USD"] }, { $ifNull: ["$priceEnteredAmount", "$price"] }, "$price"] },
    ],
  };
}

module.exports = {
  productPriceAuthority,
  productNormalPrice,
  productNormalPriceUSDExpression,
  normalizeExchangeRate,
  normalizeAmountSnapshot,
  normalizeSaleItemPricing,
  convertEnteredAmount,
  SUPPORTED_CURRENCIES,
};
