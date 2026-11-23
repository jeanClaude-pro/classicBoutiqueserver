const mongoose = require("mongoose");
const { fcProduct, productFCStages, registerFCView } = require("../utils/currency");

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
    // Since the FC-only cutover `price` (normal selling price) and `unitCost`
    // (acquisition cost of one piece) are francs, and their *FC /
    // *Entered* fields mirror them. A product not yet converted by
    // scripts/migrateToFcOnly.js is still read in FC through its own FC
    // snapshot (utils/currency.js: productPriceFC / productUnitCostFC).
    // "FC" on every record written since the FC-only cutover. Records without
    // it are pre-cutover USD records, presented in FC by utils/currency.js.
    // Deliberately no default: a default would be applied to legacy documents
    // on load and could be saved back onto a USD record.
    currency: { type: String, enum: ["FC"], default: undefined },
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

registerFCView(productSchema, { view: fcProduct, stages: productFCStages });

// Reuse if it already exists (prevents OverwriteModelError)
const Product =
  mongoose.models.Product || mongoose.model("Product", productSchema);

module.exports = Product;
