const mongoose = require("mongoose");

// Append-only stock ledger. Each row records one authoritative change of a
// product's stock inside one category stream, with the balance before/after.
// A product moved between CLOTHES and SHOES closes its old stream with
// CATEGORY_TRANSFER_OUT and opens the new one with CATEGORY_TRANSFER_IN, so a
// category's stock sheet never shows stock that belonged to the other one.
const STOCK_MOVEMENT_KINDS = Object.freeze([
  "INITIAL", "BASELINE", "MANUAL_ADJUSTMENT",
  "SALE", "SALE_CORRECTION", "SALE_VOID", "SALE_DELETE",
  "PRODUCT_DELETE", "CATEGORY_TRANSFER_OUT", "CATEGORY_TRANSFER_IN",
]);

const stockMovementSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  productName: { type: String, required: true, trim: true },
  mainCategory: { type: String, enum: ["CLOTHES", "SHOES"], required: true },
  unit: { type: String, required: true, default: "pcs" },
  quantityDelta: { type: Number, required: true },
  balanceBefore: { type: Number, required: true, min: 0 },
  balanceAfter: { type: Number, required: true, min: 0 },
  kind: { type: String, enum: STOCK_MOVEMENT_KINDS, required: true },
  sourceId: { type: String, trim: true, default: undefined },
  // Server time at which the stock actually changed. Ledger order (and so
  // every opening/closing balance) follows this, never a client clock.
  occurredAt: { type: Date, required: true, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: undefined },
}, { timestamps: true });

// Baseline detection (distinct productId) and per-product history.
stockMovementSchema.index({ productId: 1, occurredAt: 1, _id: 1 });
// Period reports: category equality + time range.
stockMovementSchema.index({ mainCategory: 1, occurredAt: 1 });

module.exports = mongoose.model("StockMovement", stockMovementSchema);
module.exports.STOCK_MOVEMENT_KINDS = STOCK_MOVEMENT_KINDS;
