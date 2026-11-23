// Single-currency (FC) bookkeeping.
//
// Since the FC-only cutover the shop works in Congolese francs exclusively:
// every new Sale, Expense, Entry, Loan and Product is written in FC, marked
// `currency: "FC"`, and carries no exchange rate. Its canonical money fields
// (price, revenue, amount, unitCost...) ARE francs, and its *FC fields mirror
// them so every reader finds the same number wherever it looks.
//
// Records written before the cutover are never rewritten. They were recorded
// in USD with an FC snapshot taken at their own historical rate. This module
// is the only place that knows how to read them: it presents a legacy record
// as an FC record using, in order, its exact FC snapshot, then its amount at
// its OWN stored rate. Today's rate is never involved (there is none any
// more), so historical figures stay exactly what was recorded at the time.
//
// Two equivalent forms are exported for every document type:
//   - a JS view for plain objects (lean reads, API responses);
//   - a MongoDB `$set` stage list for aggregations.
// The model hooks in models/*.js apply them automatically to lean reads and
// aggregations, so route code can treat every document as FC.

const CURRENCY = "FC";

const finite = (value) => {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};
const isFCRecord = (doc) => doc?.currency === CURRENCY;
const firstDefined = (...values) => values.find((value) => value !== undefined);

/* ------------------------------------------------------------------ JS -- */

function convertAt(rate) {
  return (value) => {
    const amount = finite(value);
    return amount === undefined || rate === undefined ? undefined : amount * rate;
  };
}

function fcSaleItem(item, saleRate) {
  if (!item || typeof item !== "object") return item;
  const rate = finite(item.exchangeRate) ?? finite(saleRate);
  const convert = convertAt(rate);
  const quantity = Number(item.quantity) || 0;
  const unitPrice = firstDefined(
    item.enteredCurrency === CURRENCY ? finite(item.enteredPrice) : undefined,
    finite(item.priceFC),
    finite(item.unitSellingPriceFC),
    convert(item.unitSellingPrice ?? item.priceUSD ?? item.price ?? item.unitPrice),
  );
  const revenue = firstDefined(
    finite(item.revenueFC),
    unitPrice !== undefined ? unitPrice * quantity : undefined,
    convert(item.revenue ?? item.total),
  );
  const costOfGoodsSold = firstDefined(finite(item.costOfGoodsSoldFC), convert(item.costOfGoodsSold));
  const grossProfit = firstDefined(
    finite(item.grossProfitFC),
    revenue !== undefined && costOfGoodsSold !== undefined ? revenue - costOfGoodsSold : undefined,
  );
  const isClothes = item.mainCategory === "CLOTHES";
  const isShoes = item.mainCategory === "SHOES";
  const half = grossProfit === undefined ? undefined : grossProfit / 2;
  const clothesShare = firstDefined(finite(item.clothesShareholderProfitFC), isClothes ? grossProfit : isShoes ? 0 : convert(item.clothesShareholderProfit));
  const shoe1 = firstDefined(finite(item.shoeShareholder1ProfitFC), isShoes ? half : isClothes ? 0 : convert(item.shoeShareholder1Profit));
  const shoe2 = firstDefined(finite(item.shoeShareholder2ProfitFC), isShoes ? half : isClothes ? 0 : convert(item.shoeShareholder2Profit));
  const unitCost = firstDefined(finite(item.unitAcquisitionCostFC), convert(item.unitAcquisitionCost));
  const reference = firstDefined(finite(item.referenceUnitSellingPriceFC), convert(item.referenceUnitSellingPrice));
  const discount = firstDefined(finite(item.discountPerUnitFC), convert(item.discountPerUnit));

  const view = { ...item };
  delete view.exchangeRate;
  delete view.priceUSD;
  Object.assign(view, {
    price: unitPrice,
    priceFC: unitPrice,
    enteredPrice: unitPrice,
    enteredCurrency: CURRENCY,
    unitSellingPrice: unitPrice,
    unitSellingPriceFC: unitPrice,
    revenue,
    revenueFC: revenue,
    total: revenue,
    costOfGoodsSold,
    costOfGoodsSoldFC: costOfGoodsSold,
    grossProfit,
    grossProfitFC: grossProfit,
    unitAcquisitionCost: unitCost,
    unitAcquisitionCostFC: unitCost,
    clothesShareholderProfit: clothesShare,
    clothesShareholderProfitFC: clothesShare,
    shoeShareholder1Profit: shoe1,
    shoeShareholder1ProfitFC: shoe1,
    shoeShareholder2Profit: shoe2,
    shoeShareholder2ProfitFC: shoe2,
  });
  if (item.shopProfit !== undefined || item.partnerProfit !== undefined) {
    view.shopProfit = isClothes ? clothesShare : isShoes ? shoe1 : convert(item.shopProfit);
    view.partnerProfit = isShoes ? shoe2 : isClothes ? 0 : convert(item.partnerProfit);
  }
  if (item.referenceUnitSellingPrice !== undefined || item.referenceUnitSellingPriceFC !== undefined) {
    view.referenceUnitSellingPrice = reference;
    view.referenceUnitSellingPriceFC = reference;
  }
  if (item.discountPerUnit !== undefined || item.discountPerUnitFC !== undefined) {
    view.discountPerUnit = discount;
    view.discountPerUnitFC = discount;
  }
  return view;
}

const sumDefined = (values) => {
  const present = values.filter((value) => value !== undefined);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : undefined;
};

/** A Sale (sale, reservation or legacy cash-out row) presented in FC. */
function fcSale(sale) {
  if (!sale || typeof sale !== "object" || isFCRecord(sale)) return sale;
  const rate = finite(sale.exchangeRate);
  const convert = convertAt(rate);
  const hasItems = Array.isArray(sale.items) && sale.items.length > 0;
  const items = Array.isArray(sale.items) ? sale.items.map((item) => fcSaleItem(item, rate)) : sale.items;
  const fromItems = (field) => (hasItems ? sumDefined(items.map((item) => item[field])) : undefined);
  const total = firstDefined(finite(sale.totalRevenueFC), fromItems("revenue"), convert(sale.totalRevenue ?? sale.total));
  const view = { ...sale, items };
  delete view.exchangeRate;
  view.currency = CURRENCY;
  view.total = total;
  if (sale.subtotal !== undefined) view.subtotal = total;
  if (sale.type !== "expense" || sale.totalRevenue !== undefined) {
    view.totalRevenue = total;
    view.totalRevenueFC = total;
  }
  const pairs = [
    ["costOfGoodsSold", "costOfGoodsSoldFC"],
    ["grossProfit", "grossProfitFC"],
    ["clothesShareholderProfit", "clothesShareholderProfitFC"],
    ["shoeShareholder1Profit", "shoeShareholder1ProfitFC"],
    ["shoeShareholder2Profit", "shoeShareholder2ProfitFC"],
  ];
  for (const [field, fcField] of pairs) {
    if (sale[field] === undefined && sale[fcField] === undefined && !hasItems) continue;
    const value = firstDefined(finite(sale[fcField]), fromItems(field), convert(sale[field]));
    view[field] = value;
    view[fcField] = value;
  }
  if (sale.shopProfit !== undefined) view.shopProfit = firstDefined(fromItems("shopProfit"), convert(sale.shopProfit));
  if (sale.partnerProfit !== undefined) view.partnerProfit = firstDefined(fromItems("partnerProfit"), convert(sale.partnerProfit));
  return view;
}

// Amount of a cash entry/expense/loan in FC: the FC snapshot, the entered FC
// amount, else the USD amount at the record's own rate.
function fcAmountOf(doc) {
  const rate = finite(doc.exchangeRate);
  return firstDefined(
    finite(doc.amountFC),
    doc.enteredCurrency === CURRENCY ? finite(doc.enteredAmount) : undefined,
    convertAt(rate)(doc.amountUSD ?? doc.amount),
  );
}

function fcAmountRecord(doc) {
  if (!doc || typeof doc !== "object" || isFCRecord(doc)) return doc;
  const amount = fcAmountOf(doc);
  const view = { ...doc, currency: CURRENCY, amount, amountFC: amount, enteredAmount: amount, enteredCurrency: CURRENCY };
  delete view.amountUSD;
  delete view.exchangeRate;
  return view;
}

/** An Entry presented in FC. */
const fcEntry = fcAmountRecord;

/** An Expense presented in FC, including its accounting snapshot. */
function fcExpense(expense) {
  if (!expense || typeof expense !== "object" || isFCRecord(expense)) return expense;
  const view = fcAmountRecord(expense);
  const snapshot = expense.financialSnapshot;
  if (snapshot && typeof snapshot === "object") {
    const convert = convertAt(finite(expense.exchangeRate));
    const profitUsed = firstDefined(finite(snapshot.profitUsedFC), convert(snapshot.profitUsed));
    // capital + profit always equals the amount, exactly as in the original.
    const capitalUsed = firstDefined(
      finite(snapshot.capitalUsedFC),
      view.amount !== undefined && profitUsed !== undefined ? view.amount - profitUsed : undefined,
      convert(snapshot.capitalUsed),
    );
    const converted = {};
    for (const field of ["generatedCapital", "grossProfit", "companyExpenses", "previousGoodsPurchases", "availableBefore", "availableAfter"]) {
      if (snapshot[field] !== undefined) converted[field] = convert(snapshot[field]);
    }
    view.financialSnapshot = {
      ...snapshot,
      ...converted,
      ...(snapshot.capitalUsed !== undefined || snapshot.capitalUsedFC !== undefined ? { capitalUsed, capitalUsedFC: capitalUsed } : {}),
      ...(snapshot.profitUsed !== undefined || snapshot.profitUsedFC !== undefined ? { profitUsed, profitUsedFC: profitUsed } : {}),
    };
  }
  return view;
}

/** A Loan presented in FC (loans always carried an exact FC amount). */
function fcLoan(loan) {
  if (!loan || typeof loan !== "object" || isFCRecord(loan)) return loan;
  const amount = fcAmountOf(loan);
  const view = { ...loan, currency: CURRENCY, amountFC: amount, enteredAmount: amount, enteredCurrency: CURRENCY };
  delete view.amountUSD;
  delete view.exchangeRate;
  return view;
}

// Product catalogue: the authoritative FC normal price / unit cost. A product
// not yet converted by scripts/migrateToFcOnly.js uses its own FC snapshot
// (or its USD figure at its own stored rate).
function productPriceFC(product) {
  if (!product) return undefined;
  if (isFCRecord(product)) return finite(product.price);
  return firstDefined(
    product.priceEnteredCurrency === CURRENCY ? finite(product.priceEnteredAmount) : undefined,
    finite(product.priceFC),
    convertAt(finite(product.priceExchangeRate))(product.price),
  );
}

function productUnitCostFC(product) {
  if (!product) return undefined;
  if (isFCRecord(product)) return finite(product.unitCost);
  return firstDefined(
    product.unitCostEnteredCurrency === CURRENCY ? finite(product.unitCostEnteredAmount) : undefined,
    finite(product.unitCostFC),
    convertAt(finite(product.unitCostExchangeRate))(product.unitCost),
  );
}

function fcProduct(product) {
  if (!product || typeof product !== "object" || isFCRecord(product)) return product;
  const price = productPriceFC(product);
  const unitCost = productUnitCostFC(product);
  const view = { ...product, currency: CURRENCY, price, priceFC: price, priceEnteredAmount: price, priceEnteredCurrency: CURRENCY };
  delete view.priceExchangeRate;
  if ("unitCost" in product || "unitCostFC" in product) {
    Object.assign(view, { unitCost, unitCostFC: unitCost, unitCostEnteredAmount: unitCost, unitCostEnteredCurrency: CURRENCY });
    delete view.unitCostExchangeRate;
  }
  if ("totalAcquisitionCost" in product || "totalAcquisitionCostFC" in product) {
    const total = firstDefined(
      finite(product.totalAcquisitionCostFC),
      unitCost !== undefined && finite(product.purchasedQuantity) !== undefined ? unitCost * product.purchasedQuantity : undefined,
    );
    view.totalAcquisitionCost = total;
    view.totalAcquisitionCostFC = total;
  }
  return view;
}

/* --------------------------------------------------------------- Mongo -- */

// `p` is the field prefix: "$" for a document, "$$item." inside a $map.
const f = (p, name) => `${p}${name}`;
const notNull = (expression) => ({ $ne: [{ $ifNull: [expression, null] }, null] });
const ifNull = (...expressions) => ({ $ifNull: expressions });
const times = (expression, rate) => ({
  $cond: [{ $and: [notNull(expression), notNull(rate)] }, { $multiply: [expression, rate] }, null],
});
const minus = (a, b) => ({ $cond: [{ $and: [notNull(a), notNull(b)] }, { $subtract: [a, b] }, null] });
const enteredFC = (p, amountField) => ({
  $cond: [{ $eq: [f(p, "enteredCurrency"), CURRENCY] }, f(p, amountField), null],
});

function saleItemExpression() {
  const p = "$$item.";
  const rate = ifNull(f(p, "exchangeRate"), "$exchangeRate");
  const unit = ifNull(
    enteredFC(p, "enteredPrice"),
    f(p, "priceFC"),
    f(p, "unitSellingPriceFC"),
    times(ifNull(f(p, "unitSellingPrice"), f(p, "priceUSD"), f(p, "price")), rate),
  );
  const revenue = ifNull(f(p, "revenueFC"), times(unit, f(p, "quantity")), times(ifNull(f(p, "revenue"), f(p, "total")), rate));
  const cogs = ifNull(f(p, "costOfGoodsSoldFC"), times(f(p, "costOfGoodsSold"), rate));
  const gross = ifNull(f(p, "grossProfitFC"), minus(revenue, cogs));
  const byCategory = (clothes, shoes, legacy) => ({
    $switch: {
      branches: [
        { case: { $eq: [f(p, "mainCategory"), "CLOTHES"] }, then: clothes },
        { case: { $eq: [f(p, "mainCategory"), "SHOES"] }, then: shoes },
      ],
      default: legacy,
    },
  });
  const half = { $cond: [notNull(gross), { $divide: [gross, 2] }, null] };
  const clothesShare = ifNull(f(p, "clothesShareholderProfitFC"), byCategory(gross, 0, times(f(p, "clothesShareholderProfit"), rate)));
  const shoe1 = ifNull(f(p, "shoeShareholder1ProfitFC"), byCategory(0, half, times(f(p, "shoeShareholder1Profit"), rate)));
  const shoe2 = ifNull(f(p, "shoeShareholder2ProfitFC"), byCategory(0, half, times(f(p, "shoeShareholder2Profit"), rate)));
  const unitCost = ifNull(f(p, "unitAcquisitionCostFC"), times(f(p, "unitAcquisitionCost"), rate));
  const reference = ifNull(f(p, "referenceUnitSellingPriceFC"), times(f(p, "referenceUnitSellingPrice"), rate));
  const discount = ifNull(f(p, "discountPerUnitFC"), times(f(p, "discountPerUnit"), rate));
  const keepIfPresent = (field, value) => ({ $cond: [notNull(f(p, field)), value, "$$REMOVE"] });
  const merged = {
    $mergeObjects: [
      "$$item",
      {
        price: unit,
        priceFC: unit,
        enteredPrice: unit,
        enteredCurrency: CURRENCY,
        unitSellingPrice: unit,
        unitSellingPriceFC: unit,
        revenue,
        revenueFC: revenue,
        total: revenue,
        costOfGoodsSold: cogs,
        costOfGoodsSoldFC: cogs,
        grossProfit: gross,
        grossProfitFC: gross,
        unitAcquisitionCost: unitCost,
        unitAcquisitionCostFC: unitCost,
        clothesShareholderProfit: clothesShare,
        clothesShareholderProfitFC: clothesShare,
        shoeShareholder1Profit: shoe1,
        shoeShareholder1ProfitFC: shoe1,
        shoeShareholder2Profit: shoe2,
        shoeShareholder2ProfitFC: shoe2,
        shopProfit: keepIfPresent("shopProfit", byCategory(clothesShare, shoe1, times(f(p, "shopProfit"), rate))),
        partnerProfit: keepIfPresent("partnerProfit", byCategory(0, shoe2, times(f(p, "partnerProfit"), rate))),
        referenceUnitSellingPrice: keepIfPresent("referenceUnitSellingPrice", reference),
        referenceUnitSellingPriceFC: keepIfPresent("referenceUnitSellingPrice", reference),
        discountPerUnit: keepIfPresent("discountPerUnit", discount),
        discountPerUnitFC: keepIfPresent("discountPerUnit", discount),
      },
    ],
  };
  // $mergeObjects cannot drop a field, so the legacy USD-only fields are
  // removed explicitly: a reader must never see a dollar value.
  return { $unsetField: { field: "priceUSD", input: { $unsetField: { field: "exchangeRate", input: merged } } } };
}

const LEGACY = { $ne: ["$currency", CURRENCY] };
const legacyOnly = (expression, field) => ({ $cond: [LEGACY, expression, `$${field}`] });

/** Aggregation stages presenting Sale documents in FC. */
function saleFCStages() {
  const rate = "$exchangeRate";
  const hasItems = { $gt: [{ $size: { $ifNull: ["$items", []] } }, 0] };
  const sumItems = (field) => ({ $cond: [hasItems, { $sum: `$items.${field}` }, null] });
  const pair = (field, fcField) => ifNull(`$${fcField}`, sumItems(field), times(`$${field}`, rate));
  const total = ifNull("$totalRevenueFC", sumItems("revenue"), times(ifNull("$totalRevenue", "$total"), rate));
  return [
    { $set: {
      items: legacyOnly({ $map: { input: { $ifNull: ["$items", []] }, as: "item", in: saleItemExpression() } }, "items"),
    } },
    { $set: {
      total: legacyOnly(total, "total"),
      subtotal: legacyOnly({ $cond: [notNull("$subtotal"), total, "$$REMOVE"] }, "subtotal"),
      totalRevenue: legacyOnly({ $cond: [{ $eq: ["$type", "expense"] }, "$totalRevenue", total] }, "totalRevenue"),
      totalRevenueFC: legacyOnly({ $cond: [{ $eq: ["$type", "expense"] }, "$totalRevenueFC", total] }, "totalRevenueFC"),
      costOfGoodsSold: legacyOnly(pair("costOfGoodsSold", "costOfGoodsSoldFC"), "costOfGoodsSold"),
      costOfGoodsSoldFC: legacyOnly(pair("costOfGoodsSold", "costOfGoodsSoldFC"), "costOfGoodsSoldFC"),
      grossProfit: legacyOnly(pair("grossProfit", "grossProfitFC"), "grossProfit"),
      grossProfitFC: legacyOnly(pair("grossProfit", "grossProfitFC"), "grossProfitFC"),
      clothesShareholderProfit: legacyOnly(pair("clothesShareholderProfit", "clothesShareholderProfitFC"), "clothesShareholderProfit"),
      clothesShareholderProfitFC: legacyOnly(pair("clothesShareholderProfit", "clothesShareholderProfitFC"), "clothesShareholderProfitFC"),
      shoeShareholder1Profit: legacyOnly(pair("shoeShareholder1Profit", "shoeShareholder1ProfitFC"), "shoeShareholder1Profit"),
      shoeShareholder1ProfitFC: legacyOnly(pair("shoeShareholder1Profit", "shoeShareholder1ProfitFC"), "shoeShareholder1ProfitFC"),
      shoeShareholder2Profit: legacyOnly(pair("shoeShareholder2Profit", "shoeShareholder2ProfitFC"), "shoeShareholder2Profit"),
      shoeShareholder2ProfitFC: legacyOnly(pair("shoeShareholder2Profit", "shoeShareholder2ProfitFC"), "shoeShareholder2ProfitFC"),
      shopProfit: legacyOnly({ $cond: [notNull("$shopProfit"), ifNull(sumItems("shopProfit"), times("$shopProfit", rate)), "$$REMOVE"] }, "shopProfit"),
      partnerProfit: legacyOnly({ $cond: [notNull("$partnerProfit"), ifNull(sumItems("partnerProfit"), times("$partnerProfit", rate)), "$$REMOVE"] }, "partnerProfit"),
    } },
    { $set: { exchangeRate: "$$REMOVE", currency: CURRENCY } },
  ];
}

function amountFCExpression() {
  return ifNull("$amountFC", enteredFC("$", "enteredAmount"), times(ifNull("$amountUSD", "$amount"), "$exchangeRate"));
}

/** Aggregation stages presenting Entry documents in FC. */
function entryFCStages() {
  return [
    { $set: { amount: legacyOnly(amountFCExpression(), "amount") } },
    { $set: {
      amountFC: "$amount", enteredAmount: "$amount", enteredCurrency: CURRENCY,
      amountUSD: "$$REMOVE", exchangeRate: "$$REMOVE", currency: CURRENCY,
    } },
  ];
}

/** Aggregation stages presenting Expense documents in FC. */
function expenseFCStages() {
  const rate = "$exchangeRate";
  const s = (field) => `$financialSnapshot.${field}`;
  const profitUsed = ifNull(s("profitUsedFC"), times(s("profitUsed"), rate));
  const snapshotField = (field) => ({ $cond: [notNull(s(field)), times(s(field), rate), "$$REMOVE"] });
  return [
    { $set: { amount: legacyOnly(amountFCExpression(), "amount") } },
    { $set: {
      financialSnapshot: legacyOnly({
        $cond: [
          { $eq: [{ $type: "$financialSnapshot" }, "object"] },
          { $mergeObjects: ["$financialSnapshot", {
            profitUsed, profitUsedFC: profitUsed,
            capitalUsed: ifNull(s("capitalUsedFC"), minus("$amount", profitUsed), times(s("capitalUsed"), rate)),
            capitalUsedFC: ifNull(s("capitalUsedFC"), minus("$amount", profitUsed), times(s("capitalUsed"), rate)),
            generatedCapital: snapshotField("generatedCapital"),
            grossProfit: snapshotField("grossProfit"),
            companyExpenses: snapshotField("companyExpenses"),
            previousGoodsPurchases: snapshotField("previousGoodsPurchases"),
            availableBefore: snapshotField("availableBefore"),
            availableAfter: snapshotField("availableAfter"),
          }] },
          "$financialSnapshot",
        ],
      }, "financialSnapshot"),
    } },
    { $set: {
      amountFC: "$amount", enteredAmount: "$amount", enteredCurrency: CURRENCY,
      amountUSD: "$$REMOVE", exchangeRate: "$$REMOVE", currency: CURRENCY,
    } },
  ];
}

/** Aggregation stages presenting Product documents in FC. */
function productFCStages() {
  const price = ifNull(
    { $cond: [{ $eq: ["$priceEnteredCurrency", CURRENCY] }, "$priceEnteredAmount", null] },
    "$priceFC",
    times("$price", "$priceExchangeRate"),
  );
  const unitCost = ifNull(
    { $cond: [{ $eq: ["$unitCostEnteredCurrency", CURRENCY] }, "$unitCostEnteredAmount", null] },
    "$unitCostFC",
    times("$unitCost", "$unitCostExchangeRate"),
  );
  return [
    { $set: {
      price: legacyOnly(price, "price"),
      unitCost: legacyOnly(unitCost, "unitCost"),
    } },
    { $set: {
      totalAcquisitionCost: legacyOnly(ifNull("$totalAcquisitionCostFC", times("$unitCost", "$purchasedQuantity")), "totalAcquisitionCost"),
      priceFC: "$price", priceEnteredAmount: "$price", priceEnteredCurrency: CURRENCY,
      unitCostFC: "$unitCost", unitCostEnteredAmount: "$unitCost", unitCostEnteredCurrency: CURRENCY,
      priceExchangeRate: "$$REMOVE", unitCostExchangeRate: "$$REMOVE", currency: CURRENCY,
    } },
    { $set: { totalAcquisitionCostFC: "$totalAcquisitionCost" } },
  ];
}

// The stages are inserted after the pipeline's leading $match stages so the
// collection's indexes keep serving the filter.
function withCurrencyStages(pipeline, stages) {
  let index = 0;
  while (index < pipeline.length && pipeline[index] && pipeline[index].$match) index += 1;
  if (pipeline.some((stage) => stage && stage.__fcView)) return;
  pipeline.splice(index, 0, ...stages.map((stage, position) => (position === 0 ? Object.defineProperty(stage, "__fcView", { value: true, enumerable: false }) : stage)));
}

// Registers automatic FC presentation on a schema: every aggregation and
// every lean read returns FC documents. Hydrated (non-lean) documents are
// never touched, so saving one can never rewrite a historical record.
function registerFCView(schema, { view, stages }) {
  schema.pre("aggregate", function applyFCStages() {
    withCurrencyStages(this.pipeline(), stages());
  });
  const ops = ["find", "findOne", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace"];
  schema.post(ops, function presentLeanInFC(result) {
    if (!this.mongooseOptions().lean || !result) return;
    const apply = (doc) => {
      if (!doc || typeof doc !== "object" || isFCRecord(doc)) return;
      const converted = view(doc);
      for (const key of Object.keys(doc)) if (!(key in converted)) delete doc[key];
      Object.assign(doc, converted);
    };
    if (Array.isArray(result)) result.forEach(apply);
    else apply(result);
  });
}

module.exports = {
  CURRENCY,
  isFCRecord,
  fcSale,
  fcSaleItem,
  fcEntry,
  fcExpense,
  fcLoan,
  fcProduct,
  productPriceFC,
  productUnitCostFC,
  saleFCStages,
  entryFCStages,
  expenseFCStages,
  productFCStages,
  registerFCView,
  withCurrencyStages,
};
