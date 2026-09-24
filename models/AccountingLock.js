const mongoose = require("mongoose");

const accountingLockSchema = new mongoose.Schema({
  category: { type: String, enum: ["CLOTHES", "SHOES"], required: true, unique: true },
  revision: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.models.AccountingLock || mongoose.model("AccountingLock", accountingLockSchema);
