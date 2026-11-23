const mongoose = require("mongoose");
const { fcLoan, registerFCView } = require("../utils/currency");

const loanSchema = new mongoose.Schema({
  creditorId: { type: mongoose.Schema.Types.ObjectId, ref: "Creditor", required: true, index: true },
  enteredAmount: { type: Number, required: true, min: 0 },
  // "FC" on every record written since the FC-only cutover. Records without
  // it are pre-cutover USD records, presented in FC by utils/currency.js.
  // Deliberately no default: a default would be applied to legacy documents
  // on load and could be saved back onto a USD record.
  currency: { type: String, enum: ["FC"], default: undefined },
  enteredCurrency: { type: String, enum: ["USD", "FC"], required: true },
  // amountFC is the loan's amount. amountUSD/exchangeRate exist on
  // pre-cutover loans only.
  amountUSD: { type: Number, min: 0 },
  amountFC: { type: Number, required: true, min: 0 },
  exchangeRate: { type: Number, min: 0 },
  borrowedAt: { type: Date, required: true, default: Date.now, index: true },
  reference: { type: String, trim: true, default: "" },
  note: { type: String, trim: true, default: "" },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  // Client-generated key: a retried request returns the original loan
  // instead of adding the same debt twice.
  requestKey: { type: String, trim: true, maxlength: 100, default: undefined }
}, { timestamps: true });

loanSchema.index({ creditorId: 1, borrowedAt: -1 });
loanSchema.index(
  { requestKey: 1 },
  { name: "requestKey_unique_when_set", unique: true, partialFilterExpression: { requestKey: { $type: "string" } } }
);
registerFCView(loanSchema, { view: fcLoan, stages: () => [] });
module.exports = mongoose.model("Loan", loanSchema);
