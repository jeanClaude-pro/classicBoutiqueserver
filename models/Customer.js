const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  phone: {
    type: String,
    trim: true,
    default: undefined
  },
  email: {
    type: String,
    trim: true,
    default: ""
  },
  // Explicit opt-in classification. Legacy customers remain ordinary.
  isFamilyMember: {
    type: Boolean,
    default: false
  },
  familyStatusUpdatedAt: { type: Date, default: undefined },
  familyStatusUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: undefined },
  totalPurchases: {
    type: Number,
    default: 0
  },
  totalSpent: {
    type: Number,
    default: 0
  },
  firstPurchaseDate: {
    type: Date
  },
  lastPurchaseDate: {
    type: Date
  }
}, {
  timestamps: true
});

// Create index for better query performance
customerSchema.index({ phone: 1 }, { unique: true, sparse: true });
customerSchema.index({ name: "text" });
customerSchema.index({ totalSpent: -1 });
// Family-sale member search (familyOnly=true) in the POS.
customerSchema.index({ isFamilyMember: 1, name: 1 });

module.exports = mongoose.model("Customer", customerSchema);
