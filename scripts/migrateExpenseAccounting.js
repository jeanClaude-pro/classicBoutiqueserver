require("dotenv").config();
const mongoose = require("mongoose");
const Expense = require("../models/Expense");
const Sale = require("../models/Sale");
const { ensureAccountingLocks } = require("../services/financialAccountingService");

// Idempotent. Every data change runs in one transaction (all or nothing) and
// only renames types; no legacy record is ever given a CLOTHES/SHOES category.
const LEGACY_FILTER = { $or: [{ expenseType: "normal" }, { expenseType: null }] };

async function countPending() {
  const [repayments, legacyUnclassified, fundingTerminology, unclassifiedAccountingRecords] = await Promise.all([
    Expense.countDocuments({ expenseType: "repayment" }),
    Expense.countDocuments(LEGACY_FILTER),
    Expense.countDocuments({ fundingSource: "REVENUE_CAPITAL" }),
    // Anomalies are reported, never auto-fixed: a category cannot be invented.
    Expense.countDocuments({ expenseType: { $in: ["COMPANY_EXPENSE", "GOODS_PURCHASE"] }, category: { $nin: ["CLOTHES", "SHOES"] } }),
  ]);
  return { repayments, legacyUnclassified, fundingTerminology, unclassifiedAccountingRecords };
}

// The first release declared { reversalOf: 1 } as unique + sparse. Every
// expense stores reversalOf: null and sparse indexes still index nulls, so
// that index either failed to build or rejected every second expense.
async function repairReversalIndex() {
  // createIndexes only adds missing indexes; it never drops existing ones.
  // Build the partial replacement first so reversals are never unguarded.
  await Expense.createIndexes();
  await Sale.createIndexes();
  const indexes = await Expense.collection.indexes();
  const broken = indexes.find((index) => index.name === "reversalOf_1" && !index.partialFilterExpression);
  const replaced = indexes.some((index) => index.name === "reversalOf_unique_when_set");
  if (broken && replaced) await Expense.collection.dropIndex("reversalOf_1");
  return { droppedBrokenReversalIndex: Boolean(broken && replaced) };
}

async function migrateExpenseAccounting({ dryRun = false } = {}) {
  const before = await countPending();
  if (dryRun) return { dryRun: true, wouldMigrate: before };

  const session = await mongoose.startSession();
  let migrated;
  try {
    await session.withTransaction(async () => {
      const repayments = await Expense.updateMany({ expenseType: "repayment" }, { $set: { expenseType: "REPAYMENT" } }, { session });
      const legacy = await Expense.updateMany(LEGACY_FILTER, { $set: { expenseType: "LEGACY_UNCLASSIFIED" } }, { session });
      const funding = await Expense.updateMany(
        { fundingSource: "REVENUE_CAPITAL" },
        { $set: { fundingSource: "RECOVERED_CAPITAL" } },
        { session }
      );
      migrated = { repayments: repayments.modifiedCount, legacyUnclassified: legacy.modifiedCount, fundingTerminology: funding.modifiedCount };
    });
  } finally {
    await session.endSession();
  }
  const indexes = await repairReversalIndex();
  await ensureAccountingLocks();
  return { migrated, ...indexes, anomalies: { unclassifiedAccountingRecords: before.unclassifiedAccountingRecords } };
}

if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  mongoose.connect(process.env.MONGO_URI)
    .then(() => migrateExpenseAccounting({ dryRun }))
    .then((result) => { console.log(JSON.stringify(result, null, 2)); return mongoose.disconnect(); })
    .catch((error) => { console.error(error); process.exit(1); });
}

module.exports = { migrateExpenseAccounting, repairReversalIndex, LEGACY_FILTER };
