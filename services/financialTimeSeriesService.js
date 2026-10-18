// Financial time series for the Reports chart.
//
// Every figure comes from the same building blocks as the category
// accounting (financialAccountingService): sales are recognised once, on
// completion (recognizedSaleMatch), line amounts are read from the immutable
// sale-item snapshots (saleLineAmountExpressions) and summed in integer cents,
// company expenses are the validated COMPANY_EXPENSE debits minus their
// reversals, by validation date. The sum of all buckets therefore equals the
// PERIOD figures of buildCategoryReport for the same range, to the cent.
//
// Buckets are calendar days, ISO weeks (Monday start) or months in the
// business timezone. Empty buckets are returned as real zeros so the chart
// never interpolates over days without activity.
const Sale = require("../models/Sale");
const Expense = require("../models/Expense");
const {
  CATEGORIES,
  EXPENSE_TYPES,
  recognizedSaleMatch,
  saleLineAmountExpressions,
} = require("./financialAccountingService");
const { BUSINESS_TIMEZONE, businessDateEnd, businessDateStart } = require("../utils/queryHelpers");

const GRANULARITIES = Object.freeze(["day", "week", "month"]);
const MAX_BUCKETS = Object.freeze({ day: 400, week: 260, month: 120 });
const DAY_MS = 24 * 60 * 60 * 1000;
const BUSINESS_UTC_OFFSET_MS = 2 * 60 * 60 * 1000;

const centsExpr = (expression) => ({ $floor: { $add: [{ $multiply: [expression, 100] }, 0.5] } });
const money = (cents) => Number((cents / 100).toFixed(2));
const fc = (value) => Number(Number(value || 0).toFixed(2));

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// --------------------------------------------------------------- calendar
// Bucket keys are plain business-calendar dates ("YYYY-MM-DD", the first day
// of the bucket). JavaScript only walks those strings as UTC dates, so no
// local timezone can shift a bucket.
const isoDate = (date) => date.toISOString().slice(0, 10);
const utcDate = (key) => new Date(`${key}T00:00:00.000Z`);
const businessDateOf = (instant) => isoDate(new Date(instant.getTime() + BUSINESS_UTC_OFFSET_MS));

function bucketStartKey(key, granularity) {
  const date = utcDate(key);
  if (granularity === "week") {
    const sinceMonday = (date.getUTCDay() + 6) % 7;
    return isoDate(new Date(date.getTime() - sinceMonday * DAY_MS));
  }
  if (granularity === "month") return `${key.slice(0, 7)}-01`;
  return key;
}

function nextBucketKey(key, granularity) {
  const date = utcDate(key);
  if (granularity === "week") return isoDate(new Date(date.getTime() + 7 * DAY_MS));
  if (granularity === "month") return isoDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)));
  return isoDate(new Date(date.getTime() + DAY_MS));
}

function bucketKeys(fromKey, toKey, granularity) {
  const keys = [];
  for (let key = bucketStartKey(fromKey, granularity); key <= toKey; key = nextBucketKey(key, granularity)) {
    keys.push(key);
    if (keys.length > MAX_BUCKETS[granularity]) break;
  }
  return keys;
}

function autoGranularity(days) {
  if (days <= 62) return "day";
  if (days <= 366) return "week";
  return "month";
}

/**
 * Validates the query: from/to are business dates (YYYY-MM-DD, inclusive),
 * defaulting to the last 30 days; granularity is day|week|month|auto.
 */
function parseTimeSeriesQuery(query = {}, now = new Date()) {
  const today = businessDateOf(now);
  const to = query.to ? String(query.to) : today;
  const from = query.from
    ? String(query.from)
    : isoDate(new Date(utcDate(to).getTime() - 29 * DAY_MS));
  const start = businessDateStart(from);
  const end = businessDateEnd(to);
  if (start > end) throw badRequest("Start date must be before or equal to end date");

  const days = Math.round((utcDate(to) - utcDate(from)) / DAY_MS) + 1;
  const requested = String(query.granularity || "auto").toLowerCase();
  if (requested !== "auto" && !GRANULARITIES.includes(requested)) {
    throw badRequest("Invalid granularity: use day, week, month or auto");
  }
  const granularity = requested === "auto" ? autoGranularity(days) : requested;
  const keys = bucketKeys(from, to, granularity);
  if (keys.length > MAX_BUCKETS[granularity]) {
    throw badRequest(`Range too long for ${granularity} buckets (max ${MAX_BUCKETS[granularity]})`);
  }
  return { from, to, start, end, days, granularity, keys };
}

// ------------------------------------------------------------- aggregation
// The business-calendar date of the bucket start, as "YYYY-MM-DD". Built from
// $dateToString/$isoDayOfWeek in the business timezone (no DST in
// Lubumbashi, so stepping back whole days to Monday is exact).
function bucketKeyExpression(dateExpression, granularity) {
  const toKey = (date, format) => ({ $dateToString: { date, format, timezone: BUSINESS_TIMEZONE } });
  if (granularity === "month") return toKey(dateExpression, "%Y-%m-01");
  if (granularity === "week") {
    const daysSinceMonday = { $subtract: [{ $isoDayOfWeek: { date: dateExpression, timezone: BUSINESS_TIMEZONE } }, 1] };
    return toKey({ $subtract: [dateExpression, { $multiply: [daysSinceMonday, DAY_MS] }] }, "%Y-%m-%d");
  }
  return toKey(dateExpression, "%Y-%m-%d");
}

// The instant at which recognizedSaleMatch recognises a sale: a sale at
// creation, a reservation at completion (legacy ones without a completion
// date at creation).
const RECOGNIZED_AT = {
  $cond: [
    { $and: [{ $eq: ["$type", "reservation"] }, { $ne: [{ $ifNull: ["$completedAt", null] }, null] }] },
    "$completedAt",
    "$createdAt",
  ],
};

function saleSeriesPipeline(categories, range, granularity) {
  const line = saleLineAmountExpressions();
  const sums = {
    revenueCents: { $sum: "$revenueCents" },
    cogsCents: { $sum: "$cogsCents" },
    revenueFC: { $sum: "$revenueFC" },
    cogsFC: { $sum: "$cogsFC" },
    units: { $sum: "$units" },
  };
  return [
    { $match: recognizedSaleMatch({ $in: categories }, range) },
    { $unwind: "$items" },
    { $match: { "items.mainCategory": { $in: categories } } },
    { $project: {
      bucket: bucketKeyExpression(RECOGNIZED_AT, granularity),
      category: "$items.mainCategory",
      revenueCents: line.revenueCents,
      cogsCents: line.cogsCents,
      revenueFC: line.revenueFC,
      cogsFC: line.cogsFC,
      units: "$items.quantity",
    } },
    // One row per (bucket, category, sale) so a sale is counted once per
    // category, and once in the all-category total.
    { $group: { _id: { bucket: "$bucket", category: "$category", sale: "$_id" }, ...sums } },
    { $facet: {
      byCategory: [
        { $group: {
          _id: { bucket: "$_id.bucket", category: "$_id.category" },
          revenueCents: { $sum: "$revenueCents" },
          cogsCents: { $sum: "$cogsCents" },
          revenueFC: { $sum: "$revenueFC" },
          cogsFC: { $sum: "$cogsFC" },
          units: { $sum: "$units" },
          sales: { $sum: 1 },
        } },
      ],
      salesPerBucket: [
        { $group: { _id: { bucket: "$_id.bucket", sale: "$_id.sale" } } },
        { $group: { _id: "$_id.bucket", sales: { $sum: 1 } } },
      ],
    } },
  ];
}

function companyExpenseSeriesPipeline(categories, range, granularity) {
  const sign = { $cond: [{ $eq: ["$transactionKind", "REVERSAL"] }, -1, 1] };
  return [
    { $match: {
      category: { $in: categories },
      status: "validated",
      expenseType: EXPENSE_TYPES.COMPANY,
      validatedAt: range,
    } },
    { $group: {
      _id: { bucket: bucketKeyExpression("$validatedAt", granularity), category: "$category" },
      amountCents: { $sum: { $multiply: [sign, centsExpr({ $ifNull: ["$amountUSD", "$amount"] })] } },
      amountFC: { $sum: { $multiply: [sign, { $ifNull: ["$amountFC", 0] }] } },
    } },
  ];
}

const emptyCents = () => ({ revenueCents: 0, cogsCents: 0, expenseCents: 0, revenueFC: 0, cogsFC: 0, expenseFC: 0, units: 0, sales: 0 });

function addCents(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key] || 0;
  return target;
}

// Same identities as calculateCategoryAccounting for a PERIOD:
// gross profit = revenue - COGS; net result = gross profit - company expenses.
function present(cents) {
  const grossCents = cents.revenueCents - cents.cogsCents;
  const netCents = grossCents - cents.expenseCents;
  return {
    revenue: money(cents.revenueCents),
    costOfGoodsSold: money(cents.cogsCents),
    grossProfit: money(grossCents),
    companyExpenses: money(cents.expenseCents),
    netResult: money(netCents),
    grossMargin: cents.revenueCents > 0 ? Number(((grossCents / cents.revenueCents) * 100).toFixed(2)) : null,
    revenueFC: fc(cents.revenueFC),
    costOfGoodsSoldFC: fc(cents.cogsFC),
    grossProfitFC: fc(cents.revenueFC - cents.cogsFC),
    companyExpensesFC: fc(cents.expenseFC),
    netResultFC: fc(cents.revenueFC - cents.cogsFC - cents.expenseFC),
    sales: cents.sales,
    unitsSold: cents.units,
  };
}

/**
 * Builds the series. `category` is the already-authorised category (a
 * shareholder's assigned category, a superadmin's filter) or null for both.
 */
async function buildFinancialTimeSeries({ category = null, query = {}, now = new Date() } = {}) {
  const categories = category ? [category] : [...CATEGORIES];
  const { from, to, start, end, days, granularity, keys } = parseTimeSeriesQuery(query, now);
  const range = { $gte: start, $lte: end };

  const [saleFacet, expenseRows] = await Promise.all([
    Sale.aggregate(saleSeriesPipeline(categories, range, granularity)).allowDiskUse(true),
    Expense.aggregate(companyExpenseSeriesPipeline(categories, range, granularity)),
  ]);
  const { byCategory = [], salesPerBucket = [] } = saleFacet[0] || {};

  const cells = new Map(keys.map((key) => [key, {
    total: emptyCents(),
    categories: Object.fromEntries(categories.map((name) => [name, emptyCents()])),
  }]));
  const cellFor = (bucket, name) => cells.get(bucket)?.categories[name];

  for (const row of byCategory) {
    const cell = cellFor(row._id.bucket, row._id.category);
    if (!cell) continue;
    addCents(cell, {
      revenueCents: row.revenueCents, cogsCents: row.cogsCents,
      revenueFC: row.revenueFC, cogsFC: row.cogsFC, units: row.units, sales: row.sales,
    });
  }
  for (const row of expenseRows) {
    const cell = cellFor(row._id.bucket, row._id.category);
    if (cell) addCents(cell, { expenseCents: row.amountCents, expenseFC: row.amountFC });
  }
  const distinctSales = new Map(salesPerBucket.map((row) => [row._id, row.sales]));

  const grand = emptyCents();
  const grandByCategory = Object.fromEntries(categories.map((name) => [name, emptyCents()]));
  const series = keys.map((key, index) => {
    const cell = cells.get(key);
    for (const name of categories) {
      const { sales, ...amounts } = cell.categories[name];
      addCents(cell.total, amounts);
      addCents(grandByCategory[name], cell.categories[name]);
    }
    cell.total.sales = distinctSales.get(key) || 0;
    addCents(grand, cell.total);

    // A bucket is clipped to the requested range (first and last week/month).
    const nextKey = nextBucketKey(key, granularity);
    const lastDay = isoDate(new Date(utcDate(nextKey).getTime() - DAY_MS));
    const bucketStart = index === 0 && from > key ? from : key;
    const bucketEnd = lastDay > to ? to : lastDay;
    return {
      date: key,
      start: bucketStart,
      end: bucketEnd,
      partial: bucketStart !== key || bucketEnd !== lastDay,
      ...present(cell.total),
      byCategory: Object.fromEntries(categories.map((name) => [name, present(cell.categories[name])])),
    };
  });

  return {
    range: { from, to, start, end, days },
    granularity,
    timezone: BUSINESS_TIMEZONE,
    currency: "USD",
    categories,
    series,
    totals: {
      ...present(grand),
      byCategory: Object.fromEntries(categories.map((name) => [name, present(grandByCategory[name])])),
    },
  };
}

module.exports = {
  GRANULARITIES,
  MAX_BUCKETS,
  autoGranularity,
  bucketKeys,
  buildFinancialTimeSeries,
  companyExpenseSeriesPipeline,
  parseTimeSeriesQuery,
  saleSeriesPipeline,
};
