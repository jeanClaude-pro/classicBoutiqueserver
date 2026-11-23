const mongoose = require("mongoose");

const creditorSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ["person", "bank", "company"], required: true },
  phone: { type: String, trim: true, default: "" },
  address: { type: String, trim: true, default: "" },
  isActive: { type: Boolean, default: true, index: true },
  // Balances are in FC. "FC" marks a creditor whose balances were converted
  // (or created) after the FC-only cutover; see scripts/migrateToFcOnly.js.
  currency: { type: String, enum: ["FC"], default: undefined },
  totalBorrowed: { type: Number, min: 0, default: 0 },
  totalRepaid: { type: Number, min: 0, default: 0 },
  remainingBalance: { type: Number, min: 0, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
}, { timestamps: true });

creditorSchema.index({ name: 1, isActive: 1 });
module.exports = mongoose.model("Creditor", creditorSchema);
