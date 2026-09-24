const mongoose = require("mongoose");

const saleItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Product",
    required: false // Made optional for expenses
  },
  name: {
    type: String,
    required: false // Made optional for expenses
  },
  quantity: {
    type: Number,
    required: false, // Made optional for expenses
    min: 1
  },
  price: {
    type: Number,
    required: false, // Made optional for expenses
    min: 0
  },
  enteredPrice: {
    type: Number,
    required: false,
    min: 0
  },
  enteredCurrency: {
    type: String,
    enum: ["USD", "FC"],
    required: false
  },
  priceUSD: {
    type: Number,
    required: false,
    min: 0
  },
  priceFC: {
    type: Number,
    required: false,
    min: 0
  },
  exchangeRate: {
    type: Number,
    required: false,
    min: 0
  },
  total: {
    type: Number,
    required: false, // Made optional for expenses
    min: 0
  },
  unitSellingPrice: { type: Number, required: false },
  unitAcquisitionCost: { type: Number, required: false, min: 0 },
  unitSellingPriceFC: { type: Number, required: false },
  unitAcquisitionCostFC: { type: Number, required: false, min: 0 },
  // Immutable normal-price snapshot used to authorize and explain a discount.
  // The protected floor is deliberately never persisted or returned.
  referenceUnitSellingPrice: { type: Number, required: false, min: 0 },
  referenceUnitSellingPriceFC: { type: Number, required: false, min: 0 },
  discountApplied: { type: Boolean, required: false, default: false },
  discountPerUnit: { type: Number, required: false, min: 0 },
  discountPerUnitFC: { type: Number, required: false, min: 0 },
  revenue: { type: Number, required: false },
  revenueFC: { type: Number, required: false },
  costOfGoodsSold: { type: Number, required: false },
  costOfGoodsSoldFC: { type: Number, required: false },
  grossProfit: { type: Number, required: false },
  grossProfitFC: { type: Number, required: false },
  clothesShareholderProfit: { type: Number, required: false },
  shoeShareholder1Profit: { type: Number, required: false },
  shoeShareholder2Profit: { type: Number, required: false },
  clothesShareholderProfitFC: { type: Number, required: false },
  shoeShareholder1ProfitFC: { type: Number, required: false },
  shoeShareholder2ProfitFC: { type: Number, required: false },
  shareholderAllocationRule: { type: String, enum: ["CLOTHES_OWNER_100", "SHOES_OWNERS_50_50"], required: false },
  // Deprecated compatibility fields retained for historical documents.
  shopProfit: { type: Number, required: false },
  partnerProfit: { type: Number, required: false },
  mainCategory: { type: String, enum: ["CLOTHES", "SHOES"], required: false },
  profitAllocationRule: { type: String, enum: ["SHOP_100", "SHOES_50_50"], required: false },
});

const saleSchema = new mongoose.Schema({
  saleId: {
    type: String,
    required: true,
    unique: true  // ← THIS creates an index automatically
  },
  customer: {
    name: {
      type: String,
      required: false, // Made optional for expenses
      trim: true
    },
    phone: {
      type: String,
      required: false, // Made optional for expenses
      trim: true
      // REMOVED: index: true  ← Fixed: removed duplicate index
    },
    email: {
      type: String,
      trim: true,
      default: ""
    }
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: false
  },
  // Walk-in customer: sale made without collecting customer details
  isWalkIn: {
    type: Boolean,
    default: false
  },
  items: [saleItemSchema],
  subtotal: {
    type: Number,
    required: false, // Made optional for expenses
    min: 0
  },
  total: {
    type: Number,
    required: true,
    min: 0
  },
  totalRevenue: { type: Number, required: false },
  totalRevenueFC: { type: Number, required: false },
  costOfGoodsSold: { type: Number, required: false },
  costOfGoodsSoldFC: { type: Number, required: false },
  grossProfit: { type: Number, required: false },
  grossProfitFC: { type: Number, required: false },
  clothesShareholderProfit: { type: Number, required: false },
  shoeShareholder1Profit: { type: Number, required: false },
  shoeShareholder2Profit: { type: Number, required: false },
  clothesShareholderProfitFC: { type: Number, required: false },
  shoeShareholder1ProfitFC: { type: Number, required: false },
  shoeShareholder2ProfitFC: { type: Number, required: false },
  // Deprecated compatibility fields retained for historical documents.
  shopProfit: { type: Number, required: false },
  partnerProfit: { type: Number, required: false },
  // Snapshot used for this transaction; historical sales never use today's rate.
  exchangeRate: {
    type: Number,
    required: false,
    min: 0
  },
  paymentMethod: {
    type: String,
    enum: ["cash", "card", "transfer", "other"],
    default: "cash"
  },
  saleNumber: {
    type: String,
    unique: true  // ← THIS also creates an index automatically
  },
  salesPerson: {
    type: String,
    required: true,
    trim: true,
    default: "Admin"
  },
  // --- UPDATED STATUS ENUM ---
  status: {
    type: String,
    enum: ["completed", "refunded", "pending", "voided", "corrected", "expense"], // 🔹 Added "expense"
    default: "completed"
  },
  // --- UPDATED TYPE ENUM ---
  type: {
    type: String,
    enum: ["sale", "reservation", "expense"], // 🔹 Added "expense"
    default: "sale"
  },
  // --- NEW EXPENSE FIELDS ---
  reason: {
    type: String,
    required: false, // Will be required for expenses
    trim: true
  },
  recipientName: {
    type: String,
    required: false, // Will be required for expenses
    trim: true
  },
  recipientPhone: {
    type: String,
    required: false, // Will be required for expenses
    trim: true
  },
  // --- EXISTING RESERVATION FIELDS ---
  reservationDate: {
    type: String,
    default: null
  },
  reservationTime: {
    type: String,
    default: null
  },
  notes: {
    type: String,
    default: ""
  },
  completedAt: {
    type: Date,
    default: null
  },
  completedBy: {
    type: String,
    default: null
  },
  // --- EXISTING FIELDS ---
  voidedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  voidedAt: {
    type: Date,
    default: null
  },
  // --- NEW FIELDS FOR SALE CORRECTION ---
  originalSaleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Sale",
    default: null
  },
  correctionSaleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Sale",
    default: null
  },
  editedBy: {
    type: String,
    default: null
  },
  editedAt: {
    type: Date,
    default: null
  },
  // Client-generated idempotency key: a retried submission replays the sale
  // already recorded instead of creating a duplicate (same pattern as Expense).
  requestKey: { type: String, trim: true, maxlength: 100, default: undefined },
  editHistory: [{
    editedBy: {
      type: String,
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

// Create index for better query performance
saleSchema.index({ createdAt: -1 });
saleSchema.index({ "customer.phone": 1 }); // Keep this explicit index
// REMOVED: saleSchema.index({ saleId: 1 }); ← DUPLICATE of unique: true on line 27
saleSchema.index({ salesPerson: 1 });
saleSchema.index({ status: 1 });
saleSchema.index({ type: 1, status: 1, createdAt: -1 });
saleSchema.index({ paymentMethod: 1, createdAt: -1 });
saleSchema.index({ customerId: 1, createdAt: -1 });
// Category accounting: cumulative balances match by item category and status;
// period reports recognize reservations on their completion date.
saleSchema.index({ "items.mainCategory": 1, status: 1, type: 1, createdAt: -1 });
saleSchema.index({ type: 1, status: 1, completedAt: -1 });
saleSchema.index(
  { requestKey: 1 },
  { name: "requestKey_unique_when_set", unique: true, partialFilterExpression: { requestKey: { $type: "string" } } }
);

// Pre-save middleware to calculate item totals (only for sales with items)
saleSchema.pre("save", function(next) {
  // Only calculate totals if this is a sale with items
  if (this.type === "sale" && this.items && this.items.length > 0) {
    this.items.forEach(item => {
      if (item.revenue !== undefined) {
        item.total = item.revenue;
      } else if (item.price && item.quantity) {
        item.total = item.price * item.quantity;
      }
    });
  }
  
  next();
});

module.exports = mongoose.model("Sale", saleSchema);
