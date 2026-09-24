const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },

    category: {
      type: String,
      required: true,
    },
    mainCategory: {
      type: String,
      enum: ["CLOTHES", "SHOES"],
      required: true,
      index: true,
    },
    subcategory: {
      type: String,
      trim: true,
      default: "",
    },
    brand: {
      type: String,
      default: "",
    },
    // Selling price: priceEnteredCurrency/priceEnteredAmount are the
    // authoritative normal price (see productNormalPrice in
    // utils/salePricing.js). A price defined as 20,000 FC stays 20,000 FC
    // whatever the rate; `price` is then only its USD value at
    // priceExchangeRate, and a new sale derives USD at its own rate. A USD
    // price (or a legacy product without priceEnteredCurrency) keeps `price`
    // exact and derives FC at the sale's rate.
    // unitCost remains the canonical USD acquisition cost every profit
    // calculation reads from; its entered-currency fields follow the same
    // enteredAmount/enteredCurrency/amountFC/exchangeRate snapshot pattern.
    price: {
      type: Number,
      min: 0.01,
      required: true,
    },
    priceEnteredAmount: { type: Number },
    priceEnteredCurrency: { type: String, enum: ["USD", "FC"] },
    priceFC: { type: Number },
    priceExchangeRate: { type: Number },
    purchasedQuantity: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isInteger,
    },
    totalAcquisitionCost: {
      type: Number,
      required: true,
      min: 0,
    },
    totalAcquisitionCostFC: { type: Number },
    unitCost: {
      type: Number,
      required: true,
      min: 0,
    },
    unitCostEnteredAmount: { type: Number },
    unitCostEnteredCurrency: { type: String, enum: ["USD", "FC"] },
    unitCostFC: { type: Number },
    unitCostExchangeRate: { type: Number },
    stock: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
      validate: Number.isInteger,
    },
    minStock: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    unit: {
      type: String,
      required: true,
      default: "pcs",
    },
    weight: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
  },
  {
    timestamps: true,
  }
);

// Create index for better search performance
productSchema.index({ name: "text", description: "text", brand: "text" });
productSchema.index({ category: 1 });
productSchema.index({ status: 1, createdAt: -1 });

// Reuse if it already exists (prevents OverwriteModelError)
const Product =
  mongoose.models.Product || mongoose.model("Product", productSchema);

module.exports = Product;
