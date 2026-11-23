const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Product = require("../models/Product");
const authMiddleware = require("../middleware/auth");
const isAdmin = require("../middleware/isAdmin");
const { isShareholderAdmin } = require("../middleware/authorization");
const {
  calculateTotalAcquisitionValue,
  normalizeMainCategory,
  normalizeQuantity,
} = require("../utils/profitCalculations");
const { CurrencyError, assertFC } = require("../utils/salePricing");
const { CURRENCY, fcProduct } = require("../utils/currency");
const { recordProductEditMovements, recordStockMovement } = require("../services/stockMovementService");
const { validateObjectIdParam } = require("../middleware/security");
const { requireModuleAccess } = require("../middleware/moduleAccess");
const { recordAudit } = require("../services/auditLog");
const { boundedString } = require("../utils/validation");

router.param("id", validateObjectIdParam("product ID"));
// The catalogue is read by the Products module, the POS and sale corrections.
const canReadProducts = requireModuleAccess("/products", "/", "/sales");
const PRODUCT_STATUSES = new Set(["active", "inactive"]);

const canViewAcquisitionCosts = (user) => ["admin", "superadmin"].includes(user?.role);
const acquisitionCostProjection = {
  unitCost: 0,
  unitCostEnteredAmount: 0,
  unitCostEnteredCurrency: 0,
  unitCostFC: 0,
  unitCostExchangeRate: 0,
  totalAcquisitionCost: 0,
  totalAcquisitionCostFC: 0,
};

async function runTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } finally { await session.endSession(); }
}

// Product money is FC: `price` is the normal selling price and `unitCost`
// the acquisition cost of ONE piece, both in francs. A zero unitCost is a
// legitimate acquisition cost for donated/promotional stock.
function normalizeProductMoney(fieldName, enteredAmount, enteredCurrency, { allowZero = false } = {}) {
  assertFC(enteredCurrency);
  const amount = Number(enteredAmount);
  if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount <= 0)) {
    throw new RangeError(`${fieldName} must be ${allowZero ? "zero or greater" : "greater than zero"}`);
  }
  return amount;
}

// unitCost is the acquisition cost of ONE piece, as entered by the user.
// totalAcquisitionCost (the stock's total acquisition value) is always
// derived from it — never the other way around. `existing` is a lean read,
// so a product not yet converted to FC is already presented in FC; saving it
// writes it as an FC product.
function financialProductFields(body, existing = null) {
  const mainCategory = normalizeMainCategory(body.mainCategory ?? existing?.mainCategory);
  const purchasedQuantity = normalizeQuantity(
    body.purchasedQuantity ?? existing?.purchasedQuantity,
    "purchasedQuantity"
  );
  const stock = Number(body.stock ?? existing?.stock ?? purchasedQuantity);
  if (!Number.isInteger(stock) || stock < 0) throw new RangeError("stock must be a non-negative integer");

  const priceTouched = !existing || body.price !== undefined || body.priceEnteredAmount !== undefined;
  const unitCostTouched = !existing || body.unitCost !== undefined || body.unitCostEnteredAmount !== undefined;
  const price = priceTouched
    ? normalizeProductMoney("price", body.priceEnteredAmount ?? body.price, body.priceEnteredCurrency)
    : existing.price;
  const unitCost = unitCostTouched
    ? normalizeProductMoney("unitCost", body.unitCostEnteredAmount ?? body.unitCost, body.unitCostEnteredCurrency, { allowZero: true })
    : existing.unitCost;
  if (!(Number(price) > 0)) throw new RangeError("price must be greater than zero");
  if (!Number.isFinite(Number(unitCost)) || Number(unitCost) < 0) throw new RangeError("unitCost must be zero or greater");
  const totalAcquisitionCost = calculateTotalAcquisitionValue(unitCost, purchasedQuantity);

  return {
    currency: CURRENCY,
    mainCategory,
    subcategory: String(body.subcategory ?? existing?.subcategory ?? body.category ?? existing?.category ?? "").trim(),
    category: String(body.subcategory ?? existing?.subcategory ?? body.category ?? existing?.category ?? mainCategory).trim() || mainCategory,
    purchasedQuantity,
    unitCost,
    unitCostEnteredAmount: unitCost,
    unitCostEnteredCurrency: CURRENCY,
    unitCostFC: unitCost,
    totalAcquisitionCost,
    totalAcquisitionCostFC: totalAcquisitionCost,
    price,
    priceEnteredAmount: price,
    priceEnteredCurrency: CURRENCY,
    priceFC: price,
    stock,
  };
}

// Legacy per-currency rate snapshots are dropped when a product is saved.
const LEGACY_PRODUCT_FIELDS = { priceExchangeRate: 1, unitCostExchangeRate: 1 };

const sendProduct = (product) => fcProduct(typeof product?.toObject === "function" ? product.toObject() : product);

// GET /api/products - Get all products with optional filtering
router.get("/", authMiddleware, canReadProducts, async (req, res) => {
  try {
    const search = boundedString(req.query.search, 100);
    const category = boundedString(req.query.category, 100);
    const status = boundedString(req.query.status, 20);

    // Build filter object
    const filter = {};

    if (search) {
      filter.$text = { $search: search };
    }

    if (category) {
      filter.$or = [{ category }, { subcategory: category }, { mainCategory: category.toUpperCase() }];
    }
    if (isShareholderAdmin(req.user)) {
      delete filter.$or;
      filter.mainCategory = req.user.assignedCategory;
    }

    if (status) {
      filter.status = status;
    }

    const query = Product.find(filter).sort({ createdAt: -1 }).lean();
    if (!canViewAcquisitionCosts(req.user)) query.select(acquisitionCostProjection);
    const products = await query;
    res.json(products);
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// GET /api/products/:id - Get a single product by ID
router.get("/:id", authMiddleware, canReadProducts, async (req, res) => {
  try {
    const query = Product.findOne({
      _id: req.params.id,
      ...(isShareholderAdmin(req.user) ? { mainCategory: req.user.assignedCategory } : {}),
    });
    if (!canViewAcquisitionCosts(req.user)) query.select(acquisitionCostProjection);
    const product = await query.lean();

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json(product);
  } catch (error) {
    console.error("Error fetching product:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid product ID" });
    }

    res.status(500).json({ error: "Failed to fetch product" });
  }
});

// POST /api/products - Create a new product
router.post("/", authMiddleware, isAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      category,
      brand,
      price,
      stock,
      minStock,
      unit,
      weight,
      status,
      mainCategory,
      subcategory,
      purchasedQuantity,
      unitCost,
    } = req.body;

    // Validate required fields
    const hasUnitCost = unitCost !== undefined || req.body.unitCostEnteredAmount !== undefined;
    const hasPrice = price !== undefined || req.body.priceEnteredAmount !== undefined;
    if (!name || !mainCategory || purchasedQuantity === undefined || !hasUnitCost || !hasPrice) {
      return res.status(400).json({
        error: "name, mainCategory, purchasedQuantity, unitCost and price are required",
      });
    }

    if (status !== undefined && !PRODUCT_STATUSES.has(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const financialFields = financialProductFields(req.body);
    const product = new Product({
      name: boundedString(name, 200),
      description: boundedString(description, 2000),
      ...financialFields,
      brand: boundedString(brand, 100),
      minStock: Number(minStock) || 0,
      unit: boundedString(unit, 30) || "pcs",
      weight: Number(weight) || 0,
      status: status || "active",
    });

    const savedProduct = await runTransaction(async (session) => {
      await product.save({ session });
      await recordStockMovement({
        product,
        quantityDelta: product.stock,
        balanceBefore: 0,
        balanceAfter: product.stock,
        kind: "INITIAL",
        sourceId: String(product._id),
        occurredAt: product.createdAt,
        createdBy: req.user._id,
        session,
      });
      return product;
    });
    await recordAudit({ req, action: "PRODUCT_CREATED", targetType: "Product", targetId: savedProduct._id, after: { name: savedProduct.name, mainCategory: savedProduct.mainCategory, stock: savedProduct.stock, currency: CURRENCY, price: savedProduct.price, unitCost: savedProduct.unitCost } });
    res.status(201).json(sendProduct(savedProduct));
  } catch (error) {
    console.error("Error creating product:", error);

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }

    if (error instanceof RangeError || error instanceof TypeError || error instanceof CurrencyError) {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: "Failed to create product" });
  }
});

// PUT /api/products/:id - Update a product
router.put("/:id", authMiddleware, isAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      category,
      brand,
      price,
      stock,
      minStock,
      unit,
      weight,
      status,
      mainCategory,
      subcategory,
      purchasedQuantity,
      unitCost,
    } = req.body;

    if (status !== undefined && !PRODUCT_STATUSES.has(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const existingProduct = await Product.findById(req.params.id).lean();
    if (!existingProduct) return res.status(404).json({ error: "Product not found" });
    const financialFields = financialProductFields(req.body, existingProduct);

    // Build update object with only provided fields
    const updateData = {};

    if (name !== undefined) updateData.name = boundedString(name, 200);
    if (description !== undefined) updateData.description = boundedString(description, 2000);
    Object.assign(updateData, financialFields);
    if (brand !== undefined) updateData.brand = boundedString(brand, 100);
    if (minStock !== undefined) updateData.minStock = Number(minStock);
    if (unit !== undefined) updateData.unit = boundedString(unit, 30) || "pcs";
    if (weight !== undefined) updateData.weight = Number(weight);
    if (status !== undefined) updateData.status = status;

    // Sales change stock with $inc (no __v bump), so the stock value read
    // above is part of the guard: an edit racing a sale is refused instead of
    // silently overwriting the sale's deduction and desynchronising the ledger.
    const updatedProduct = await runTransaction(async (session) => {
      const updated = await Product.findOneAndUpdate(
        { _id: req.params.id, __v: existingProduct.__v, stock: existingProduct.stock },
        { $set: updateData, $unset: LEGACY_PRODUCT_FIELDS, $inc: { __v: 1 } },
        { new: true, runValidators: true, session }
      );
      if (updated) {
        await recordProductEditMovements({ before: existingProduct, after: updated, createdBy: req.user._id, session });
      }
      return updated;
    });

    if (!updatedProduct) {
      return res.status(409).json({ error: "Product changed; refresh and retry" });
    }

    const tracked = ["name", "stock", "currency", "price", "unitCost", "mainCategory", "status", "minStock"];
    await recordAudit({
      req, action: "PRODUCT_UPDATED", targetType: "Product", targetId: updatedProduct._id,
      before: Object.fromEntries(tracked.map((key) => [key, existingProduct[key]])),
      after: Object.fromEntries(tracked.map((key) => [key, updatedProduct[key]])),
    });
    res.json(sendProduct(updatedProduct));
  } catch (error) {
    console.error("Error updating product:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid product ID" });
    }

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }

    if (error instanceof RangeError || error instanceof TypeError || error instanceof CurrencyError) {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: "Failed to update product" });
  }
});

// DELETE /api/products/:id - Delete a product
router.delete("/:id", authMiddleware, isAdmin, async (req, res) => {
  try {
    // The ledger keeps the deleted product's history and closes its stream
    // at zero, so later stock sheets do not carry phantom stock forward.
    const deletedProduct = await runTransaction(async (session) => {
      const removed = await Product.findByIdAndDelete(req.params.id, { session });
      if (removed && ["CLOTHES", "SHOES"].includes(removed.mainCategory)) {
        await recordStockMovement({
          product: removed,
          quantityDelta: -removed.stock,
          balanceBefore: removed.stock,
          balanceAfter: 0,
          kind: "PRODUCT_DELETE",
          sourceId: String(removed._id),
          createdBy: req.user._id,
          session,
        });
      }
      return removed;
    });

    if (!deletedProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

    await recordAudit({ req, action: "PRODUCT_DELETED", targetType: "Product", targetId: deletedProduct._id, before: deletedProduct });
    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    console.error("Error deleting product:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid product ID" });
    }

    res.status(500).json({ error: "Failed to delete product" });
  }
});

module.exports = router;
