const Sale = require("../models/Sale");
const Expense = require("../models/Expense");
const AccountingLock = require("../models/AccountingLock");

const CATEGORIES = Object.freeze(["CLOTHES", "SHOES"]);
const EXPENSE_TYPES = Object.freeze({
  COMPANY: "COMPANY_EXPENSE",
  GOODS: "GOODS_PURCHASE",
  REPAYMENT: "REPAYMENT",
  LEGACY: "LEGACY_UNCLASSIFIED",
});
// PERIOD = performance of a date range. BALANCE = cumulative position as of
// now; only a BALANCE can say how much money is still available to spend.
const BASIS = Object.freeze({ PERIOD: "PERIOD", BALANCE: "BALANCE" });

// All accounting arithmetic happens in integer cents. Math.round(x) is
// floor(x + 0.5), and the Mongo expression below reproduces it exactly so the
// database and JavaScript always round an amount to the same cent.
const cents = (value) => Math.round(Number(value || 0) * 100);
const money = (value) => Number((value / 100).toFixed(2));
const addMoney = (...values) => money(values.reduce((sum, value) => sum + cents(value), 0));
const centsExpr = (expression) => ({ $floor: { $add: [{ $multiply: [expression, 100] }, 0.5] } });

function assertCategory(category) {
  if (!CATEGORIES.includes(category)) {
    const error = new Error("category must be CLOTHES or SHOES");
    error.status = 400;
    throw error;
  }
  return category;
}

// Splits a non-negative amount of cents between the two SHOES shareholders.
// Shareholder 1 receives the odd cent, so the two parts always add up exactly.
function splitShoesProfit(distributableCents) {
  const shareholder2 = Math.floor(distributableCents / 2);
  return { shareholder1: distributableCents - shareholder2, shareholder2 };
}

/**
 * The single definition of category accounting. Every screen, report and
 * validation derives its numbers from this function.
 *
 *   gross profit      = revenue - COGS (COGS is the recovered acquisition capital)
 *   net result        = gross profit - validated company expenses (may be negative)
 *   capital pool      = recovered capital - any loss (a loss is paid out of capital)
 *   CLOTHES resources = capital pool + positive net profit (= recovered capital + net result)
 *   SHOES resources   = capital pool only; SHOES profit never funds merchandise
 *   available funds   = max(0, resources - validated goods purchases)
 *
 * CLOTHES purchases consume capital first and profit second; the split is
 * frozen in each purchase's snapshot. SHOES distributable profit is the
 * positive net result, split 50/50 in whole cents.
 */
function calculateCategoryAccounting({
  category, revenue = 0, costOfGoodsSold = 0, grossProfit,
  companyExpenses = 0, goodsPurchases = 0,
  capitalUsedForPurchases, profitUsedForPurchases,
}, { basis = BASIS.BALANCE } = {}) {
  assertCategory(category);
  const isClothes = category === "CLOTHES";
  const revenueCents = cents(revenue);
  const capitalCents = cents(costOfGoodsSold);
  const grossCents = grossProfit === undefined ? revenueCents - capitalCents : cents(grossProfit);
  const companyExpenseCents = cents(companyExpenses);
  const purchaseCents = cents(goodsPurchases);
  const netCents = grossCents - companyExpenseCents;

  const lossCoveredByCapitalCents = Math.max(0, -netCents);
  const capitalPoolCents = capitalCents - lossCoveredByCapitalCents;
  const profitPoolCents = Math.max(0, netCents);

  // Historical purchases carry a frozen capital/profit split. Anything not
  // explained by a snapshot is attributed to capital, never silently to profit.
  let capitalUsedCents;
  let profitUsedCents;
  if (!isClothes) {
    capitalUsedCents = purchaseCents;
    profitUsedCents = 0;
  } else if (capitalUsedForPurchases === undefined && profitUsedForPurchases === undefined) {
    capitalUsedCents = Math.min(Math.max(0, purchaseCents), Math.max(0, capitalPoolCents));
    profitUsedCents = purchaseCents - capitalUsedCents;
  } else {
    profitUsedCents = cents(profitUsedForPurchases);
    capitalUsedCents = purchaseCents - profitUsedCents;
  }

  const resourcesCents = isClothes ? capitalPoolCents + profitPoolCents : capitalPoolCents;
  const balanceCents = resourcesCents - purchaseCents;
  const isBalance = basis === BASIS.BALANCE;

  let distributableCents;
  if (!isClothes) {
    distributableCents = profitPoolCents;
  } else if (isBalance) {
    // If capital is short (a sale was voided after its capital was spent, or
    // an expense was validated after profit was reinvested), CLOTHES profit
    // covers the gap before anything becomes distributable.
    distributableCents = Math.max(0, Math.min(profitPoolCents - profitUsedCents, balanceCents));
  } else {
    distributableCents = Math.max(0, profitPoolCents - profitUsedCents);
  }
  const availableCents = Math.max(0, balanceCents);
  const shortfallCents = Math.max(0, -balanceCents);
  const remainingCapitalCents = isClothes ? availableCents - distributableCents : availableCents;
  const split = isClothes
    ? { shareholder1: distributableCents, shareholder2: 0 }
    : splitShoesProfit(distributableCents);
  const balanceOnly = (value) => (isBalance ? money(value) : null);

  return {
    category,
    basis,
    revenue: money(revenueCents),
    costOfGoodsSold: money(capitalCents),
    grossProfit: money(grossCents),
    companyExpenses: money(companyExpenseCents),
    netProfit: money(netCents),
    goodsPurchases: money(purchaseCents),
    recoveredCapital: money(capitalCents),
    lossCoveredByCapital: money(lossCoveredByCapitalCents),
    capitalUsedForPurchases: money(capitalUsedCents),
    profitUsedForPurchases: money(profitUsedCents),
    distributableProfit: money(distributableCents),
    shareholder1: money(split.shareholder1),
    shareholder2: money(split.shareholder2),
    generatedPurchaseFunds: money(resourcesCents),
    // A period cannot tell how much is still spendable: capital recovered in
    // an earlier period may still be available, so these are BALANCE-only.
    remainingRecoveredCapital: balanceOnly(remainingCapitalCents),
    availableNetProfit: balanceOnly(distributableCents),
    availablePurchaseFunds: balanceOnly(availableCents),
    fundingShortfall: balanceOnly(shortfallCents),
  };
}

// Sales are recognized once, when they are completed: a sale at creation, a
// reservation at completion (legacy completed reservations without a
// completion date fall back to their creation date).
function recognizedSaleMatch(category, range) {
  const match = { type: { $in: ["sale", "reservation"] }, status: "completed", "items.mainCategory": category };
  if (range) {
    match.$or = [
      { type: "sale", createdAt: range },
      { type: "reservation", completedAt: range },
      { type: "reservation", completedAt: null, createdAt: range },
    ];
  }
  return match;
}

function saleTotalsPipeline(category, range) {
  const itemRate = { $ifNull: ["$items.exchangeRate", { $ifNull: ["$exchangeRate", 0] }] };
  const revenueUSD = { $ifNull: ["$items.revenue", { $multiply: [{ $ifNull: ["$items.priceUSD", "$items.price"] }, "$items.quantity"] }] };
  const cogsUSD = { $ifNull: ["$items.costOfGoodsSold", 0] };
  return [
    { $match: recognizedSaleMatch(category, range) },
    { $unwind: "$items" },
    { $match: { "items.mainCategory": category } },
    { $project: {
      revenueCents: centsExpr(revenueUSD),
      cogsCents: centsExpr(cogsUSD),
      storedGrossCents: centsExpr("$items.grossProfit"),
      quantity: "$items.quantity",
      revenueFC: { $ifNull: ["$items.revenueFC", { $multiply: [revenueUSD, itemRate] }] },
      cogsFC: { $ifNull: ["$items.costOfGoodsSoldFC", { $multiply: [cogsUSD, itemRate] }] },
    } },
    { $group: {
      _id: null,
      revenueCents: { $sum: "$revenueCents" },
      cogsCents: { $sum: "$cogsCents" },
      revenueFC: { $sum: "$revenueFC" },
      cogsFC: { $sum: "$cogsFC" },
      lines: { $sum: 1 },
      unitsSold: { $sum: "$quantity" },
      // Gross profit is always revenue - COGS; a stored snapshot that
      // disagrees is surfaced for audit instead of breaking the identity.
      grossSnapshotMismatches: { $sum: { $cond: [{ $and: [
        { $ne: ["$storedGrossCents", null] },
        { $ne: ["$storedGrossCents", { $subtract: ["$revenueCents", "$cogsCents"] }] },
      ] }, 1, 0] } },
    } },
  ];
}

function expenseTotalsPipeline(category, range) {
  const match = { category, status: "validated", expenseType: { $in: [EXPENSE_TYPES.COMPANY, EXPENSE_TYPES.GOODS] } };
  if (range) match.validatedAt = range;
  const sign = { $cond: [{ $eq: ["$transactionKind", "REVERSAL"] }, -1, 1] };
  const signed = (expression) => ({ $multiply: [sign, expression] });
  return [
    { $match: match },
    { $group: {
      _id: "$expenseType",
      amountCents: { $sum: signed(centsExpr({ $ifNull: ["$amountUSD", "$amount"] })) },
      capitalUsedCents: { $sum: signed(centsExpr({ $ifNull: ["$financialSnapshot.capitalUsed", 0] })) },
      profitUsedCents: { $sum: signed(centsExpr({ $ifNull: ["$financialSnapshot.profitUsed", 0] })) },
      amountFC: { $sum: signed({ $ifNull: ["$amountFC", 0] }) },
      profitUsedFC: { $sum: signed({ $ifNull: ["$financialSnapshot.profitUsedFC", 0] }) },
      count: { $sum: 1 },
      reversals: { $sum: { $cond: [{ $eq: ["$transactionKind", "REVERSAL"] }, 1, 0] } },
    } },
  ];
}

const fc = (value) => Number(Number(value || 0).toFixed(2));

/**
 * Authoritative category accounting from immutable Sale and Expense
 * snapshots. Without `range` it is the cumulative BALANCE used to authorize
 * purchases; with `range` it is PERIOD performance for reports.
 */
async function aggregateCategoryAccounting(category, { session = null, range = null } = {}) {
  assertCategory(category);
  const saleAggregate = Sale.aggregate(saleTotalsPipeline(category, range));
  const expenseAggregate = Expense.aggregate(expenseTotalsPipeline(category, range));
  let saleRows;
  let expenseRows;
  if (session) {
    // Operations inside one transaction must never run in parallel.
    saleRows = await saleAggregate.session(session);
    expenseRows = await expenseAggregate.session(session);
  } else {
    [saleRows, expenseRows] = await Promise.all([saleAggregate, expenseAggregate]);
  }
  const sales = saleRows[0] || {};
  const byType = Object.fromEntries(expenseRows.map((row) => [row._id, row]));
  const company = byType[EXPENSE_TYPES.COMPANY] || {};
  const goods = byType[EXPENSE_TYPES.GOODS] || {};
  const basis = range ? BASIS.PERIOD : BASIS.BALANCE;
  const accounting = calculateCategoryAccounting({
    category,
    revenue: money(sales.revenueCents || 0),
    costOfGoodsSold: money(sales.cogsCents || 0),
    companyExpenses: money(company.amountCents || 0),
    goodsPurchases: money(goods.amountCents || 0),
    capitalUsedForPurchases: money(goods.capitalUsedCents || 0),
    profitUsedForPurchases: money(goods.profitUsedCents || 0),
  }, { basis });
  // FC figures are informational: historical-rate sums run through the same
  // formula. USD cents remain the authoritative accounting currency.
  const accountingFC = calculateCategoryAccounting({
    category,
    revenue: fc(sales.revenueFC),
    costOfGoodsSold: fc(sales.cogsFC),
    companyExpenses: fc(company.amountFC),
    goodsPurchases: fc(goods.amountFC),
    profitUsedForPurchases: category === "CLOTHES" ? fc(goods.profitUsedFC) : undefined,
  }, { basis });
  return {
    ...accounting,
    revenueFC: accountingFC.revenue,
    costOfGoodsSoldFC: accountingFC.costOfGoodsSold,
    grossProfitFC: accountingFC.grossProfit,
    companyExpensesFC: accountingFC.companyExpenses,
    netProfitFC: accountingFC.netProfit,
    goodsPurchasesFC: accountingFC.goodsPurchases,
    profitUsedForPurchasesFC: accountingFC.profitUsedForPurchases,
    distributableProfitFC: accountingFC.distributableProfit,
    shareholder1FC: accountingFC.shareholder1,
    shareholder2FC: accountingFC.shareholder2,
    activity: {
      saleLines: sales.lines || 0,
      unitsSold: sales.unitsSold || 0,
      companyExpenseTransactions: company.count || 0,
      goodsPurchaseTransactions: goods.count || 0,
      reversals: (company.reversals || 0) + (goods.reversals || 0),
    },
    integrity: {
      grossProfitSnapshotMismatches: sales.grossSnapshotMismatches || 0,
    },
    range: range ? { start: range.$gte, end: range.$lte } : null,
  };
}

const BALANCE_FIELDS = Object.freeze([
  "recoveredCapital", "lossCoveredByCapital", "netProfit", "goodsPurchases",
  "capitalUsedForPurchases", "profitUsedForPurchases", "remainingRecoveredCapital",
  "availablePurchaseFunds", "fundingShortfall", "generatedPurchaseFunds",
  "distributableProfit", "shareholder1", "shareholder2",
]);

/**
 * Report DTO for one category: PERIOD performance at the top level plus the
 * CURRENT cumulative balance under `balance`. Filtering a report by date must
 * never make recovered-but-unspent capital from earlier periods disappear.
 */
async function buildCategoryReport(category, range) {
  const [period, balance] = await Promise.all([
    aggregateCategoryAccounting(category, { range }),
    aggregateCategoryAccounting(category),
  ]);
  const balanceView = Object.fromEntries(BALANCE_FIELDS.map((field) => [field, balance[field]]));
  return {
    ...period,
    balance: { ...balanceView, asOf: new Date() },
    availablePurchaseFunds: balance.availablePurchaseFunds,
    remainingRecoveredCapital: balance.remainingRecoveredCapital,
    fundingShortfall: balance.fundingShortfall,
  };
}

/**
 * Serializes every accounting decision of a category inside the caller's
 * transaction. Concurrent writers conflict on the lock document; the
 * transaction driver retries them against the committed state.
 */
async function acquireAccountingLock(category, session) {
  assertCategory(category);
  const lock = await AccountingLock.findOneAndUpdate(
    { category },
    { $inc: { revision: 1 } },
    { new: true, session }
  );
  if (!lock) throw Object.assign(new Error("Accounting lock is not initialized"), { status: 503 });
  return lock.revision;
}

// Locks every category touched by a set of sale items, in a stable order.
async function acquireAccountingLocksForItems(items, session) {
  const categories = [...new Set((items || []).map((item) => item?.mainCategory).filter((value) => CATEGORIES.includes(value)))].sort();
  for (const category of categories) await acquireAccountingLock(category, session);
  return categories;
}

function purchaseSnapshot(accounting, requestedAmount) {
  if (accounting.basis !== BASIS.BALANCE) {
    throw Object.assign(new Error("Purchases must be authorized against the cumulative balance"), { status: 500 });
  }
  const requestedCents = cents(requestedAmount);
  if (requestedCents <= 0) {
    throw Object.assign(new Error("Purchase amount must be at least 0.01 USD"), { status: 400 });
  }
  const availableCents = cents(accounting.availablePurchaseFunds);
  if (requestedCents > availableCents) {
    const error = new Error("Fonds de réapprovisionnement insuffisants");
    error.status = 409;
    error.code = "INSUFFICIENT_PURCHASE_FUNDS";
    error.details = { category: accounting.category, requested: money(requestedCents), available: money(availableCents) };
    throw error;
  }
  const remainingCapitalCents = cents(accounting.remainingRecoveredCapital);
  const capitalUsedCents = Math.min(requestedCents, remainingCapitalCents);
  const profitUsedCents = accounting.category === "CLOTHES" ? requestedCents - capitalUsedCents : 0;
  if (capitalUsedCents + profitUsedCents !== requestedCents) {
    throw Object.assign(new Error("SHOES purchases can only use recovered capital"), { status: 409, code: "INSUFFICIENT_PURCHASE_FUNDS" });
  }
  return {
    fundingSource: profitUsedCents === 0 ? "RECOVERED_CAPITAL" : capitalUsedCents === 0 ? "PROFIT" : "MIXED",
    financialSnapshot: {
      generatedCapital: accounting.recoveredCapital,
      grossProfit: accounting.grossProfit,
      companyExpenses: accounting.companyExpenses,
      previousGoodsPurchases: accounting.goodsPurchases,
      availableBefore: accounting.availablePurchaseFunds,
      capitalUsed: money(capitalUsedCents),
      profitUsed: money(profitUsedCents),
      availableAfter: money(availableCents - requestedCents),
      calculatedAt: new Date(),
    },
  };
}

// Projected balance after adding (or, with a negative sign, removing) one
// validated transaction. Used for the availableAfter field of snapshots.
function projectAccounting(accounting, { companyExpenses = 0, goodsPurchases = 0, capitalUsed = 0, profitUsed = 0 }) {
  return calculateCategoryAccounting({
    category: accounting.category,
    revenue: accounting.revenue,
    costOfGoodsSold: accounting.costOfGoodsSold,
    grossProfit: accounting.grossProfit,
    companyExpenses: addMoney(accounting.companyExpenses, companyExpenses),
    goodsPurchases: addMoney(accounting.goodsPurchases, goodsPurchases),
    capitalUsedForPurchases: addMoney(accounting.capitalUsedForPurchases, capitalUsed),
    profitUsedForPurchases: addMoney(accounting.profitUsedForPurchases, profitUsed),
  });
}

async function ensureAccountingLocks() {
  await Promise.all(CATEGORIES.map((category) => AccountingLock.updateOne(
    { category }, { $setOnInsert: { category, revision: 0 } }, { upsert: true }
  )));
}

module.exports = {
  BASIS, CATEGORIES, EXPENSE_TYPES, addMoney, assertCategory, calculateCategoryAccounting,
  aggregateCategoryAccounting, buildCategoryReport, acquireAccountingLock,
  acquireAccountingLocksForItems, purchaseSnapshot, projectAccounting, ensureAccountingLocks,
  saleTotalsPipeline, expenseTotalsPipeline, splitShoesProfit,
};
