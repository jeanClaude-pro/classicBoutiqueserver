// FC-only cutover: one-time, idempotent data step.
//
//   node scripts/migrateToFcOnly.js            -> dry run: reports, writes nothing
//   node scripts/migrateToFcOnly.js --apply    -> performs the changes below
//
// Take a backup first (mongodump) and run it right after deploying the
// FC-only server, before the shop records new transactions.
//
// What it changes — CURRENT STATE ONLY, never a recorded transaction:
//   1. Product catalogue: every product not yet in FC gets its normal selling
//      price and unit cost in FC. A price/cost that was defined in FC keeps
//      its exact FC amount; one defined in USD is converted at the final
//      exchange rate (the rate the till was using until the cutover, so the
//      FC price a cashier saw yesterday is the FC price from now on). The
//      previous values are kept under `fcCutover.previous` on each product.
//   2. Creditor balances (borrowed / repaid / remaining) are recomputed in FC
//      from the loans' exact FC amounts and the repayments' FC amounts.
//   3. Customer `totalSpent` is recomputed in FC from the customer's sales.
//
// What it never changes: the amounts of any Sale, Expense, Entry or Loan.
// Those records keep exactly what was recorded, and the application reads
// them in FC through their own FC snapshot taken at their own historical
// rate (utils/currency.js).
//
// The single exception is additive and only concerns very old records that
// carry neither an FC snapshot nor their own rate (so they could not be read
// in FC at all): they receive the `exchangeRate` that was in effect on their
// date, from the exchange-rate history. No amount is modified.
require("dotenv").config();
const mongoose = require("mongoose");
const Sale = require("../models/Sale");
const Expense = require("../models/Expense");
const { CURRENCY, fcSale, fcExpense, fcEntry } = require("../utils/currency");

const MIGRATION = "fc-only-cutover";
const round2 = (value) => Math.round(Number(value) * 100) / 100;
const finite = (value) => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? undefined : Number(value));

function rateHistory(rates) {
  const sorted = rates.filter((rate) => finite(rate.rate) > 0).sort((a, b) => new Date(a.effectiveFrom) - new Date(b.effectiveFrom));
  return (date) => {
    if (!sorted.length) return undefined;
    const time = new Date(date || 0).getTime();
    let found = sorted[0];
    for (const rate of sorted) if (new Date(rate.effectiveFrom).getTime() <= time) found = rate;
    return Number(found.rate);
  };
}

async function finalExchangeRate(db) {
  const rates = db.collection("exchangerates");
  const active = await rates.find({ isActive: true }).sort({ effectiveFrom: -1 }).limit(1).next();
  const latest = active || await rates.find({}).sort({ effectiveFrom: -1 }).limit(1).next();
  return { rate: finite(latest?.rate), source: active ? "active" : latest ? "latest" : "none", all: await rates.find({}).toArray() };
}

function productFCFields(product, finalRate) {
  const priceFC = product.priceEnteredCurrency === CURRENCY
    ? finite(product.priceEnteredAmount) ?? finite(product.priceFC)
    : finalRate ? Math.round(Number(product.priceEnteredAmount ?? product.price) * finalRate) : undefined;
  const costFC = product.unitCostEnteredCurrency === CURRENCY
    ? finite(product.unitCostEnteredAmount) ?? finite(product.unitCostFC)
    : finalRate ? round2(Number(product.unitCostEnteredAmount ?? product.unitCost) * finalRate) : undefined;
  if (!(priceFC > 0) || costFC === undefined || costFC < 0) return null;
  const quantity = Number(product.purchasedQuantity) || 0;
  return {
    currency: CURRENCY,
    price: priceFC, priceFC, priceEnteredAmount: priceFC, priceEnteredCurrency: CURRENCY,
    unitCost: costFC, unitCostFC: costFC, unitCostEnteredAmount: costFC, unitCostEnteredCurrency: CURRENCY,
    totalAcquisitionCost: round2(costFC * quantity), totalAcquisitionCostFC: round2(costFC * quantity),
  };
}

async function migrateProducts(db, finalRate, apply, at) {
  const products = db.collection("products");
  const legacy = await products.find({ currency: { $ne: CURRENCY } }).toArray();
  const operations = [];
  const unconvertible = [];
  const samples = [];
  for (const product of legacy) {
    const fields = productFCFields(product, finalRate);
    if (!fields) { unconvertible.push({ _id: String(product._id), name: product.name }); continue; }
    if (samples.length < 10) samples.push({ name: product.name, before: { price: product.price, priceCurrency: product.priceEnteredCurrency || "USD", unitCost: product.unitCost, unitCostCurrency: product.unitCostEnteredCurrency || "USD" }, after: { price: fields.price, unitCost: fields.unitCost } });
    const previous = {};
    for (const key of ["price", "priceEnteredAmount", "priceEnteredCurrency", "priceFC", "priceExchangeRate", "unitCost", "unitCostEnteredAmount", "unitCostEnteredCurrency", "unitCostFC", "unitCostExchangeRate", "totalAcquisitionCost", "totalAcquisitionCostFC"]) {
      if (product[key] !== undefined) previous[key] = product[key];
    }
    operations.push({ updateOne: {
      filter: { _id: product._id, currency: { $ne: CURRENCY } },
      update: { $set: { ...fields, fcCutover: { at, rate: finalRate, previous } }, $unset: { priceExchangeRate: "", unitCostExchangeRate: "" } },
    } });
  }
  if (apply && operations.length) await products.bulkWrite(operations, { ordered: false });
  return { toConvert: operations.length, unconvertible, samples };
}

async function migrateCreditors(db, apply, at) {
  const creditors = await db.collection("creditors").find({ currency: { $ne: CURRENCY } }).toArray();
  if (!creditors.length) return { toConvert: 0 };
  const ids = creditors.map((creditor) => creditor._id);
  const loans = await db.collection("loans").aggregate([
    { $match: { creditorId: { $in: ids } } },
    { $group: { _id: "$creditorId", total: { $sum: "$amountFC" } } },
  ]).toArray();
  // Repayments through the Expense model hook: each is read in FC.
  const repayments = await Expense.aggregate([
    { $match: { creditorId: { $in: ids }, expenseType: { $in: ["REPAYMENT", "repayment"] }, status: "validated", repaymentAppliedAt: { $ne: null } } },
    { $group: { _id: "$creditorId", total: { $sum: "$amount" } } },
  ]);
  const borrowed = new Map(loans.map((row) => [String(row._id), row.total || 0]));
  const repaid = new Map(repayments.map((row) => [String(row._id), row.total || 0]));
  const operations = creditors.map((creditor) => {
    const totalBorrowed = round2(borrowed.get(String(creditor._id)) || 0);
    const totalRepaid = round2(repaid.get(String(creditor._id)) || 0);
    return { updateOne: {
      filter: { _id: creditor._id, currency: { $ne: CURRENCY } },
      update: { $set: {
        currency: CURRENCY, totalBorrowed, totalRepaid, remainingBalance: Math.max(0, round2(totalBorrowed - totalRepaid)),
        fcCutover: { at, previous: { totalBorrowed: creditor.totalBorrowed, totalRepaid: creditor.totalRepaid, remainingBalance: creditor.remainingBalance } },
      } },
    } };
  });
  if (apply) await db.collection("creditors").bulkWrite(operations, { ordered: false });
  return { toConvert: operations.length };
}

async function recomputeCustomers(db, apply) {
  // Same rule as recalculateCustomerStats in routes/sales.js, in FC.
  const rows = await Sale.aggregate([
    { $match: { customerId: { $ne: null }, type: { $in: ["sale", "reservation"] }, status: { $in: ["completed", "pending", null] } } },
    { $group: { _id: "$customerId", totalSpent: { $sum: { $ifNull: ["$total", 0] } } } },
  ]);
  const operations = rows.map((row) => ({ updateOne: { filter: { _id: row._id }, update: { $set: { totalSpent: round2(row.totalSpent) } } } }));
  if (apply && operations.length) {
    await db.collection("customers").updateMany({ _id: { $nin: rows.map((row) => row._id) }, totalSpent: { $ne: 0 } }, { $set: { totalSpent: 0 } });
    await db.collection("customers").bulkWrite(operations, { ordered: false });
  }
  return { customersWithSales: operations.length };
}

// Records that cannot be read in FC at all: no FC snapshot, no own rate.
async function backfillMissingRates(db, rateAt, apply) {
  const report = {};
  const specs = [
    { name: "sales", view: fcSale, unreadable: (view) => view.total === undefined || (view.items || []).some((item) => item.revenue === undefined) },
    { name: "expenses", view: fcExpense, unreadable: (view) => view.amount === undefined },
    { name: "entries", view: fcEntry, unreadable: (view) => view.amount === undefined },
  ];
  for (const spec of specs) {
    const collection = db.collection(spec.name);
    const cursor = collection.find({ currency: { $ne: CURRENCY }, $or: [{ exchangeRate: { $exists: false } }, { exchangeRate: null }] });
    const operations = [];
    let noRateAvailable = 0;
    for await (const doc of cursor) {
      if (!spec.unreadable(spec.view(doc))) continue;
      const rate = rateAt(doc.createdAt);
      if (!rate) { noRateAvailable += 1; continue; }
      operations.push({ updateOne: { filter: { _id: doc._id, currency: { $ne: CURRENCY } }, update: { $set: { exchangeRate: rate, fcCutoverRateBackfilled: true } } } });
    }
    if (apply && operations.length) await collection.bulkWrite(operations, { ordered: false });
    report[spec.name] = { needingHistoricalRate: operations.length, noRateAvailable };
  }
  return report;
}

async function migrateToFcOnly({ apply = false } = {}) {
  const db = mongoose.connection.db;
  const at = new Date();
  const previousRun = await db.collection("systemmigrations").findOne({ name: MIGRATION });
  const { rate: finalRate, source, all } = await finalExchangeRate(db);
  const legacyProducts = await db.collection("products").countDocuments({ currency: { $ne: CURRENCY }, $or: [{ priceEnteredCurrency: { $ne: CURRENCY } }, { unitCostEnteredCurrency: { $ne: CURRENCY } }] });
  if (!finalRate && legacyProducts > 0) {
    throw new Error("No exchange rate found, but some products are priced in USD: their FC price cannot be determined.");
  }

  const summary = {
    mode: apply ? "APPLY" : "DRY RUN (nothing written; add --apply)",
    previousRun: previousRun ? previousRun.appliedAt : null,
    finalExchangeRate: finalRate ? { rate: finalRate, source } : null,
    products: await migrateProducts(db, finalRate, apply, at),
    creditors: await migrateCreditors(db, apply, at),
    customers: await recomputeCustomers(db, apply),
    historicalRecordsWithoutFC: await backfillMissingRates(db, rateHistory(all), apply),
  };
  if (apply) {
    await db.collection("systemmigrations").updateOne(
      { name: MIGRATION },
      { $set: { name: MIGRATION, appliedAt: at, finalExchangeRate: finalRate, summary: JSON.parse(JSON.stringify(summary)) } },
      { upsert: true }
    );
  }
  return summary;
}

if (require.main === module) {
  const apply = process.argv.includes("--apply");
  (async () => {
    if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
    await mongoose.connect(process.env.MONGO_URI);
    try {
      console.log(JSON.stringify(await migrateToFcOnly({ apply }), null, 2));
    } finally {
      await mongoose.disconnect();
    }
  })().catch((error) => { console.error(error.message); process.exit(1); });
}

module.exports = { migrateToFcOnly, productFCFields, rateHistory };
