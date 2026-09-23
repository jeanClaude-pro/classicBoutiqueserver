const express = require("express");
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
const {
  normalizeExchangeRate,
  convertEnteredAmount,
  SUPPORTED_CURRENCIES,
} = require("../utils/salePricing");
const { getFallbackExchangeRate } = require("../utils/currentExchangeRate");

// unitCost/price stay the canonical USD figures every profit calculation
// reads from (semantics unchanged). This mirrors normalizeAmountSnapshot
// (same convertEnteredAmount formula) but allows a zero unitCost, which is a
// legitimate acquisition cost for donated/promotional stock.
function normalizeProductMoney(fieldName, enteredAmount, enteredCurrency, exchangeRateInput, fallbackRate, { allowZero = false } = {}) {
  const amount = Number(enteredAmount);
  if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount <= 0)) {
    throw new RangeError(`${fieldName} must be ${allowZero ? "zero or greater" : "greater than zero"}`);
  }
  const currency = enteredCurrency || "USD";
  if (!SUPPORTED_CURRENCIES.has(currency)) {
    throw new RangeError(`${fieldName}EnteredCurrency must be USD or FC`);
  }
  const exchangeRate = normalizeExchangeRate(exchangeRateInput ?? fallbackRate);
  if (currency === "FC" && !exchangeRate) {
    throw new RangeError(`exchangeRate is required for an FC ${fieldName}`);
  }
  const { amountUSD, amountFC } = convertEnteredAmount(amount, currency, exchangeRate);
  return { amountUSD, enteredAmount: amount, enteredCurrency: currency, amountFC, exchangeRate };
}

// unitCost is the acquisition cost of ONE piece, as entered by the user.
// totalAcquisitionCost (the stock's total acquisition value) is always
// derived from it — never the other way around.
async function financialProductFields(body, existing = null) {
  const mainCategory = normalizeMainCategory(body.mainCategory ?? existing?.mainCategory);
  const purchasedQuantity = normalizeQuantity(
    body.purchasedQuantity ?? existing?.purchasedQuantity,
    "purchasedQuantity"
  );
  const stock = Number(body.stock ?? existing?.stock ?? purchasedQuantity);
  if (!Number.isInteger(stock) || stock < 0) throw new RangeError("stock must be a non-negative integer");

  const priceTouched = !existing || body.price !== undefined || body.priceEnteredAmount !== undefined || body.priceEnteredCurrency !== undefined;
  const unitCostTouched = !existing || body.unitCost !== undefined || body.unitCostEnteredAmount !== undefined || body.unitCostEnteredCurrency !== undefined;
  const fallbackRate = (priceTouched || unitCostTouched) ? await getFallbackExchangeRate() : undefined;

  let price = {
    amountUSD: existing?.price,
    enteredAmount: existing?.priceEnteredAmount,
    enteredCurrency: existing?.priceEnteredCurrency,
    amountFC: existing?.priceFC,
    exchangeRate: existing?.priceExchangeRate,
  };
  if (priceTouched) {
    price = normalizeProductMoney(
      "price",
      body.priceEnteredAmount ?? body.price,
      body.priceEnteredCurrency,
      body.priceExchangeRate,
      fallbackRate
    );
  }

  let unitCost = {
    amountUSD: existing?.unitCost,
    enteredAmount: existing?.unitCostEnteredAmount,
    enteredCurrency: existing?.unitCostEnteredCurrency,
    amountFC: existing?.unitCostFC,
    exchangeRate: existing?.unitCostExchangeRate,
  };
  if (unitCostTouched) {
    unitCost = normalizeProductMoney(
      "unitCost",
      body.unitCostEnteredAmount ?? body.unitCost,
      body.unitCostEnteredCurrency,
      body.unitCostExchangeRate,
      fallbackRate,
      { allowZero: true }
    );
  }

  const totalAcquisitionCost = calculateTotalAcquisitionValue(unitCost.amountUSD, purchasedQuantity);
  const totalAcquisitionCostFC =
    unitCost.amountFC !== undefined ? Math.round(unitCost.amountFC * purchasedQuantity) : undefined;

  return {
    mainCategory,
    subcategory: String(body.subcategory ?? existing?.subcategory ?? body.category ?? existing?.category ?? "").trim(),
    category: String(body.subcategory ?? existing?.subcategory ?? body.category ?? existing?.category ?? mainCategory).trim() || mainCategory,
    purchasedQuantity,
    unitCost: unitCost.amountUSD,
    unitCostEnteredAmount: unitCost.enteredAmount,
    unitCostEnteredCurrency: unitCost.enteredCurrency,
    unitCostFC: unitCost.amountFC,
    unitCostExchangeRate: unitCost.exchangeRate,
    totalAcquisitionCost,
    totalAcquisitionCostFC,
    price: price.amountUSD,
    priceEnteredAmount: price.enteredAmount,
    priceEnteredCurrency: price.enteredCurrency,
    priceFC: price.amountFC,
    priceExchangeRate: price.exchangeRate,
    stock,
  };
}

// GET /api/products - Get all products with optional filtering
router.get("/", authMiddleware, async (req, res) => {
  console.log("Fetching products with filters:", req.query);
  try {
    const { search, category, status } = req.query;

    // Build filter object
    const filter = {};

    if (search) {
      filter.$text = { $search: search };
    }

    if (category) {
      filter.$or = [{ category }, { subcategory: category }, { mainCategory: String(category).toUpperCase() }];
    }
    if (isShareholderAdmin(req.user)) {
      delete filter.$or;
      filter.mainCategory = req.user.assignedCategory;
    }

    if (status) {
      filter.status = status;
    }

    const products = await Product.find(filter).sort({ createdAt: -1 });
    res.json(products);
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// GET /api/products/:id - Get a single product by ID
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      ...(isShareholderAdmin(req.user) ? { mainCategory: req.user.assignedCategory } : {}),
    });

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

    const financialFields = await financialProductFields(req.body);
    const product = new Product({
      name,
      description: description || "",
      ...financialFields,
      brand: brand || "",
      minStock: Number(minStock) || 0,
      unit: unit || "pcs",
      weight: Number(weight) || 0,
      status: status || "active",
    });

    const savedProduct = await product.save();
    res.status(201).json(savedProduct);
  } catch (error) {
    console.error("Error creating product:", error);

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }

    if (error instanceof RangeError || error instanceof TypeError) {
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

    const existingProduct = await Product.findById(req.params.id).lean();
    if (!existingProduct) return res.status(404).json({ error: "Product not found" });
    const financialFields = await financialProductFields(req.body, existingProduct);

    // Build update object with only provided fields
    const updateData = {};

    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    Object.assign(updateData, financialFields);
    if (brand !== undefined) updateData.brand = brand;
    if (minStock !== undefined) updateData.minStock = Number(minStock);
    if (unit !== undefined) updateData.unit = unit;
    if (weight !== undefined) updateData.weight = Number(weight);
    if (status !== undefined) updateData.status = status;

    const updatedProduct = await Product.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!updatedProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json(updatedProduct);
  } catch (error) {
    console.error("Error updating product:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid product ID" });
    }

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }

    if (error instanceof RangeError || error instanceof TypeError) {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: "Failed to update product" });
  }
});

// DELETE /api/products/:id - Delete a product
router.delete("/:id", authMiddleware, isAdmin, async (req, res) => {
  try {
    const deletedProduct = await Product.findByIdAndDelete(req.params.id);

    if (!deletedProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

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
