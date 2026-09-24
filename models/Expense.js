const mongoose = require("mongoose");

const expenseSchema = new mongoose.Schema({
  expenseId: {
    type: String,
    required: true,
    unique: true
  },
  reason: {
    type: String,
    required: true,
    trim: true
  },
  recipientName: {
    type: String,
    required: true,
    trim: true
  },
  recipientPhone: {
    type: String,
    required: true,
    trim: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  enteredAmount: { type: Number, min: 0 },
  enteredCurrency: { type: String, enum: ["USD", "FC"], default: "USD" },
  amountUSD: { type: Number, min: 0 },
  amountFC: { type: Number, min: 0 },
  exchangeRate: { type: Number, min: 0 },
  paymentMethod: {
    type: String,
    enum: ["cash", "mpesa", "bank", "card", "other"],
    default: "cash"
  },
  status: {
    type: String,
    enum: ["pending", "validated", "rejected"],
    default: "pending"
  },
  recordedBy: {
    type: String,
    required: true,
    trim: true
  },
  validatedBy: {
    type: String,
    default: null
  },
  validatedAt: {
    type: Date,
    default: null
  },
  notes: {
    type: String,
    default: ""
  },
  // New records use the uppercase accounting enums. The two lowercase values
  // remain readable until the legacy migration has been run.
  expenseType: {
    type: String,
    enum: ["COMPANY_EXPENSE", "GOODS_PURCHASE", "REPAYMENT", "LEGACY_UNCLASSIFIED", "normal", "repayment"],
    default: "LEGACY_UNCLASSIFIED",
    index: true
  },
  category: { type: String, enum: ["CLOTHES", "SHOES"], default: undefined, index: true },
  fundingSource: { type: String, enum: ["RECOVERED_CAPITAL", "REVENUE_CAPITAL", "PROFIT", "MIXED"], default: undefined },
  transactionKind: { type: String, enum: ["DEBIT", "REVERSAL"], default: "DEBIT", index: true },
  reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: "Expense", default: null },
  reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Expense", default: null },
  reversalReason: { type: String, trim: true, default: "" },
  financialSnapshot: {
    generatedCapital: { type: Number, min: 0 },
    grossProfit: { type: Number },
    companyExpenses: { type: Number, min: 0 },
    previousGoodsPurchases: { type: Number, min: 0 },
    availableBefore: { type: Number, min: 0 },
    capitalUsed: { type: Number, min: 0 },
    profitUsed: { type: Number, min: 0 },
    capitalUsedFC: { type: Number, min: 0 },
    profitUsedFC: { type: Number, min: 0 },
    availableAfter: { type: Number, min: 0 },
    calculatedAt: { type: Date }
  },
  creditorId: { type: mongoose.Schema.Types.ObjectId, ref: "Creditor", default: null },
  creditorSnapshot: {
    name: { type: String, trim: true },
    type: { type: String, enum: ["person", "bank", "company"] }
  },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  // Client-generated key that makes a repeated create request return the
  // original record instead of recording (and auto-validating) it twice.
  requestKey: { type: String, trim: true, maxlength: 100, default: undefined },
  repaymentAppliedAt: { type: Date, default: null },
  repaymentAppliedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
}, {
  timestamps: true
});

// Create index for better query performance
// NOTE: Removed duplicate index for expenseId (already created by unique: true)
expenseSchema.index({ createdAt: -1 });
expenseSchema.index({ recordedBy: 1 });
expenseSchema.index({ status: 1, createdAt: -1 });
expenseSchema.index({ paymentMethod: 1, createdAt: -1 });
expenseSchema.index({ creditorId: 1, status: 1, repaymentAppliedAt: -1 });
expenseSchema.index({ category: 1, expenseType: 1, status: 1, validatedAt: -1 });
// reversalOf defaults to null on every expense. A sparse index still indexes
// explicit nulls, so uniqueness must be limited to real references.
expenseSchema.index(
  { reversalOf: 1 },
  { name: "reversalOf_unique_when_set", unique: true, partialFilterExpression: { reversalOf: { $type: "objectId" } } }
);
expenseSchema.index(
  { requestKey: 1 },
  { name: "requestKey_unique_when_set", unique: true, partialFilterExpression: { requestKey: { $type: "string" } } }
);

module.exports = mongoose.model("Expense", expenseSchema);
