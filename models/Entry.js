const mongoose = require("mongoose");
const { entryFCStages, fcEntry, registerFCView } = require("../utils/currency");

const entrySchema = new mongoose.Schema({
  entryId: {
    type: String,
    required: true,
    unique: true
  },
  // "FC" on every record written since the FC-only cutover. Records without
  // it are pre-cutover USD records, presented in FC by utils/currency.js.
  // Deliberately no default: a default would be applied to legacy documents
  // on load and could be saved back onto a USD record.
  currency: { type: String, enum: ["FC"], default: undefined },
  // Core entry data
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  enteredAmount: { type: Number, min: 0 },
  // Legacy values remain readable; new records are always "FC".
  enteredCurrency: { type: String, enum: ["USD", "FC"] },
  amountUSD: { type: Number, min: 0 },
  amountFC: { type: Number, min: 0 },
  exchangeRate: { type: Number, min: 0 },
  source: {
    type: String,
    required: true,
    trim: true
  },
  paymentMethod: {
    type: String,
    enum: ["cash", "card", "transfer", "other"],
    default: "cash"
  },
  category: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: false,
    trim: true,
    default: ""
  },
  // Who the money was received from (like your customer object)
  receivedFrom: {
    name: {
      type: String,
      required: false,
      trim: true
    },
    phone: {
      type: String,
      required: false,
      trim: true
    },
    email: {
      type: String,
      trim: true,
      default: ""
    }
  },
  // Client-generated key: a create request retried after a dropped
  // connection returns the original entry instead of recording it twice.
  requestKey: { type: String, trim: true, maxlength: 100, default: undefined },
  // Status and audit (following your Sale pattern)
  status: {
    type: String,
    enum: ["active", "deleted"],
    default: "active"
  },
  // Creator info
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  // Editor info
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  // Delete info (admin only)
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  deletedAt: {
    type: Date,
    default: null
  },
  // Version history (exactly like your Sale model)
  editHistory: [{
    editedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    editedAt: {
      type: Date,
      default: Date.now
    },
    changes: {
      type: Map,
      of: mongoose.Schema.Types.Mixed
    },
    reason: String
  }],
}, {
  timestamps: true
});

// Indexes for performance (like your Sale model)
// NOTE: Removed duplicate index for entryId (already created by unique: true)
entrySchema.index({ createdAt: -1 });
entrySchema.index({ "receivedFrom.phone": 1 });
entrySchema.index({ source: 1 });
entrySchema.index({ status: 1, createdAt: -1 });
entrySchema.index({ paymentMethod: 1, createdAt: -1 });
entrySchema.index({ category: 1, createdAt: -1 });
// Only real keys are unique; entries saved before this field existed have none.
entrySchema.index(
  { requestKey: 1 },
  { name: "requestKey_unique_when_set", unique: true, partialFilterExpression: { requestKey: { $type: "string" } } }
);

registerFCView(entrySchema, { view: fcEntry, stages: entryFCStages });

module.exports = mongoose.model("Entry", entrySchema);
