const mongoose = require("mongoose");
const Product = require("../models/Product");
const Sale = require("../models/Sale");
const StockMovement = require("../models/StockMovement");
const { buildTimeframeFilter } = require("../utils/queryHelpers");
const { recognizedSaleMatch, saleLineAmountExpressions } = require("../services/financialAccountingService");
const { isShareholderAdmin, isSuperadmin } = require("../middleware/authorization");
const { productNormalPrice } = require("../utils/salePricing");

const CATEGORIES = ["CLOTHES", "SHOES"];
const SALE_KINDS = ["SALE", "SALE_CORRECTION", "SALE_VOID", "SALE_DELETE"];
// A category stream that starts with one of these did not exist before it.
const STREAM_OPENERS = ["INITIAL", "CATEGORY_TRANSFER_IN"];
// A stream whose last movement is one of these holds nothing any more.
const STREAM_CLOSERS = ["PRODUCT_DELETE", "CATEGORY_TRANSFER_OUT"];
// Everything the FC presentation of a product price needs (utils/currency.js).
const PRICE_FIELDS = "name unit status mainCategory subcategory brand stock currency price priceEnteredAmount priceEnteredCurrency priceFC priceExchangeRate";

// Shareholder accounts are pinned to their assigned category whatever the
// query says; other roles may filter to one category or see both.
function reportCategory(req) {
  if (isShareholderAdmin(req.user)) return req.user.assignedCategory;
  const requested = String(req.query.category || "").toUpperCase();
  return CATEGORIES.includes(requested) ? requested : null;
}

// Purchase cost and profit follow the same rule as acquisition costs on
// products: the operational superadmin, or a shareholder for its category.
const canViewFinancials = (user) => isSuperadmin(user) || isShareholderAdmin(user);

function reportRange(req) {
  return buildTimeframeFilter(req.query, "occurredAt").occurredAt;
}

const streamKey = (productId, category) => `${productId}:${category}`;
const sortedGroup = (match, group) => [
  { $match: match },
  { $sort: { occurredAt: 1, _id: 1 } },
  { $group: { _id: { productId: "$productId", category: "$mainCategory" }, ...group } },
];
const cents = (value) => Math.round(Number(value) * 100);

function sendReportError(res, error, label) {
  if (/Invalid date|Invalid year|Invalid month|Start date/.test(error.message)) {
    return res.status(400).json({ error: error.message });
  }
  console.error(`${label} aggregation failed:`, error);
  return res.status(500).json({ error: `Failed to generate ${label.toLowerCase()}` });
}

// Every amount in these reports is in FC, returned as { fc } money objects.
// Current normal selling price of a product (read-only).
function sellingPriceOf(product) {
  if (!product) return null;
  const { fc } = productNormalPrice(product);
  if (!Number.isFinite(fc)) return null;
  return { currency: "FC", fc: cents(fc) / 100 };
}

// Inventory value at selling price = quantity x current unit selling price.
// This is a valuation of unsold stock, never revenue.
function inventoryValue(quantity, price) {
  if (typeof quantity !== "number" || !price || price.fc === null || price.fc === undefined) return null;
  return { fc: (quantity * cents(price.fc)) / 100 };
}

// Fiche de stock: opening balance -> period changes -> closing balance per
// product and category stream, derived from the stock ledger only.
//   opening  = last balanceAfter strictly before the period start
//   closing  = last balanceAfter at or before the period end
//   opening + additions - reductions - salesOut = closing
// `productId` restricts every query to that one product (individual fiche).
async function buildStockSheet({ categories, start, end, productId = null }) {
  const categoryMatch = { mainCategory: { $in: categories } };
  const productMatch = productId ? { productId: new mongoose.Types.ObjectId(String(productId)) } : {};
  const [beforeRows, withinRows, trackedIds] = await Promise.all([
    StockMovement.aggregate(sortedGroup(
      { ...categoryMatch, ...productMatch, occurredAt: { $lt: start } },
      {
        opening: { $last: "$balanceAfter" },
        lastKind: { $last: "$kind" },
        productName: { $last: "$productName" },
        unit: { $last: "$unit" },
      },
    )).allowDiskUse(true),
    StockMovement.aggregate(sortedGroup(
      { ...categoryMatch, ...productMatch, occurredAt: { $gte: start, $lte: end } },
      {
        firstKind: { $first: "$kind" },
        closing: { $last: "$balanceAfter" },
        productName: { $last: "$productName" },
        unit: { $last: "$unit" },
        additions: { $sum: { $cond: [{ $and: [{ $not: [{ $in: ["$kind", SALE_KINDS] }] }, { $gt: ["$quantityDelta", 0] }] }, "$quantityDelta", 0] } },
        reductions: { $sum: { $cond: [{ $and: [{ $not: [{ $in: ["$kind", SALE_KINDS] }] }, { $lt: ["$quantityDelta", 0] }] }, { $abs: "$quantityDelta" }, 0] } },
        salesOut: { $sum: { $cond: [{ $in: ["$kind", SALE_KINDS] }, { $multiply: ["$quantityDelta", -1] }, 0] } },
      },
    )).allowDiskUse(true),
    StockMovement.distinct("productId", { ...productMatch, occurredAt: { $lte: end } }),
  ]);

  const before = new Map(beforeRows.map((row) => [streamKey(row._id.productId, row._id.category), row]));
  const within = new Map(withinRows.map((row) => [streamKey(row._id.productId, row._id.category), row]));
  const keys = new Set([...before.keys(), ...within.keys()]);
  const streamProductIds = [...new Set([...beforeRows, ...withinRows].map((row) => String(row._id.productId)))];

  // Products that existed by the period end but have no ledger row at all up
  // to that point: shown, but flagged instead of given invented balances.
  const untrackedFilter = {
    ...categoryMatch,
    _id: productId ? productId : { $nin: trackedIds },
    $or: [{ createdAt: { $lte: end } }, { createdAt: { $exists: false } }],
  };
  const skipUntracked = Boolean(productId) && trackedIds.length > 0;
  const [currentProducts, untrackedProducts] = await Promise.all([
    Product.find({ _id: { $in: streamProductIds } }).select(PRICE_FIELDS).lean(),
    skipUntracked ? [] : Product.find(untrackedFilter).select(PRICE_FIELDS).lean(),
  ]);
  const productById = new Map(currentProducts.map((product) => [String(product._id), product]));

  const withValuation = (row, product) => {
    const sellingPrice = row.status === "deleted" ? null : sellingPriceOf(product);
    return { ...row, sellingPrice, inventoryValue: inventoryValue(row.closingStock, sellingPrice) };
  };

  const rows = [];
  for (const key of keys) {
    const prior = before.get(key);
    const period = within.get(key);
    // A stream closed (deleted / moved to the other category) before the
    // period, with no activity inside it, has nothing to report.
    if (prior && !period && STREAM_CLOSERS.includes(prior.lastKind)) continue;
    const source = period || prior;
    const id = String(source._id.productId);
    const current = productById.get(id);
    let openingStock;
    let trackingComplete = true;
    if (prior) openingStock = prior.opening;
    else if (STREAM_OPENERS.includes(period.firstKind)) openingStock = 0;
    else { openingStock = null; trackingComplete = false; }
    rows.push(withValuation({
      productId: id,
      product: current?.name || source.productName,
      category: source._id.category,
      unit: current?.unit || source.unit || "pcs",
      status: current ? current.status : "deleted",
      openingStock,
      additions: period?.additions || 0,
      reductions: period?.reductions || 0,
      salesOut: period?.salesOut || 0,
      closingStock: period ? period.closing : prior.opening,
      trackingComplete,
    }, current));
  }
  for (const product of untrackedProducts) {
    rows.push(withValuation({
      productId: String(product._id),
      product: product.name,
      category: product.mainCategory,
      unit: product.unit || "pcs",
      status: product.status,
      openingStock: null,
      additions: 0,
      reductions: 0,
      salesOut: 0,
      closingStock: null,
      trackingComplete: false,
    }, product));
  }
  rows.sort((a, b) => a.product.localeCompare(b.product, "fr") || a.category.localeCompare(b.category));
  const totals = rows.reduce((sum, row) => ({
    openingStock: sum.openingStock + (row.openingStock ?? 0),
    additions: sum.additions + row.additions,
    reductions: sum.reductions + row.reductions,
    salesOut: sum.salesOut + row.salesOut,
    closingStock: sum.closingStock + (row.closingStock ?? 0),
    inventoryValueCents: sum.inventoryValueCents + (row.inventoryValue?.fc != null ? cents(row.inventoryValue.fc) : 0),
  }), { openingStock: 0, additions: 0, reductions: 0, salesOut: 0, closingStock: 0, inventoryValueCents: 0 });
  const { inventoryValueCents, ...quantities } = totals;
  return {
    rows,
    currency: "FC",
    totals: { ...quantities, inventoryValue: { fc: inventoryValueCents / 100 } },
    complete: rows.every((row) => row.trackingComplete),
  };
}

async function stockSheet(req, res) {
  try {
    const category = reportCategory(req);
    const range = reportRange(req);
    const report = await buildStockSheet({ categories: category ? [category] : CATEGORIES, start: range.$gte, end: range.$lte });
    res.set("Cache-Control", "no-store");
    return res.json({
      source: "stock-movement-aggregation",
      category: category || "ALL",
      period: { start: range.$gte, end: range.$lte },
      ...report,
    });
  } catch (error) {
    return sendReportError(res, error, "Stock sheet");
  }
}

// Fiche de stock of ONE product, in its current category stream. A
// category-pinned shareholder cannot read a product of the other category.
async function productStockSheet(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid product ID" });
    const product = await Product.findById(req.params.id).select(`${PRICE_FIELDS} createdAt`).lean();
    if (!product) return res.status(404).json({ error: "Product not found" });
    if (isShareholderAdmin(req.user) && product.mainCategory !== req.user.assignedCategory) {
      return res.status(403).json({ error: "CATEGORY_FORBIDDEN", message: "Ce produit appartient à une autre catégorie." });
    }
    const range = reportRange(req);
    const report = await buildStockSheet({ categories: [product.mainCategory], start: range.$gte, end: range.$lte, productId: product._id });
    const row = report.rows.find((item) => item.productId === String(product._id)) || null;
    res.set("Cache-Control", "no-store");
    return res.json({
      source: "stock-movement-aggregation",
      period: { start: range.$gte, end: range.$lte },
      currency: "FC",
      product: {
        productId: String(product._id),
        name: product.name,
        category: product.mainCategory,
        subcategory: product.subcategory || "",
        brand: product.brand || "",
        unit: product.unit || "pcs",
        status: product.status,
        currentStock: product.stock,
        sellingPrice: sellingPriceOf(product),
      },
      // null when the product did not exist yet during the period.
      row,
    });
  } catch (error) {
    return sendReportError(res, error, "Product stock sheet");
  }
}

// Fiche des ventes / Products sold: physical units sold per product over
// recognised sales only (the same recognition rule as category accounting):
// completed sales by createdAt, reservations only once completed, by
// completedAt. Voided, refunded, corrected and pending records never match;
// an offline sale is a single Sale document whatever the number of sync
// attempts (unique requestKey).
// Amounts come from each line's immutable snapshots (actual selling price,
// discounts and family prices included; purchase cost at the time of sale):
//   revenue = actual selling amount;  profit = revenue - purchase cost
// so revenue = purchase cost + profit holds exactly (integer hundredths of
// a franc). Sales are presented in FC by the Sale model hook, historical
// records through their own FC snapshots.
async function buildSalesSheet({ categories, start, end, financials }) {
  const range = { $gte: start, $lte: end };
  const line = saleLineAmountExpressions();
  const grouped = await Sale.aggregate([
    { $match: recognizedSaleMatch({ $in: categories }, range) },
    { $unwind: "$items" },
    { $match: { "items.mainCategory": { $in: categories } } },
    { $group: {
      _id: {
        productId: "$items.productId",
        category: "$items.mainCategory",
        // The unit price each line was actually sold at (discounts and
        // family prices included).
        unitPriceCents: { $round: [{ $multiply: [{ $ifNull: ["$items.price", 0] }, 100] }, 0] },
      },
      name: { $last: "$items.name" },
      quantity: { $sum: "$items.quantity" },
      revenueCents: { $sum: line.revenueCents },
      purchaseCostCents: { $sum: line.cogsCents },
    } },
    { $lookup: { from: "products", localField: "_id.productId", foreignField: "_id", as: "product" } },
    { $project: {
      _id: 0,
      productId: { $toString: "$_id.productId" },
      product: { $ifNull: [{ $arrayElemAt: ["$product.name", 0] }, "$name"] },
      category: "$_id.category",
      unit: { $ifNull: [{ $arrayElemAt: ["$product.unit", 0] }, "pcs"] },
      unitPriceCents: "$_id.unitPriceCents",
      quantity: 1, revenueCents: 1, purchaseCostCents: 1,
    } },
  ]).allowDiskUse(true);

  const fcMoney = (valueCents) => ({ fc: valueCents / 100 });
  // One row per product (and category): every price it was sold at with the
  // pieces that left at that price, then the product's totals.
  const byProduct = new Map();
  for (const group of grouped) {
    const key = `${group.productId}:${group.category}`;
    const row = byProduct.get(key) ?? {
      productId: group.productId, product: group.product, category: group.category, unit: group.unit,
      quantitySold: 0, revenueCents: 0, purchaseCostCents: 0, prices: [],
    };
    row.quantitySold += group.quantity;
    row.revenueCents += group.revenueCents;
    row.purchaseCostCents += group.purchaseCostCents;
    row.prices.push({
      currency: "FC",
      unitPrice: fcMoney(group.unitPriceCents),
      quantity: group.quantity,
      revenue: fcMoney(group.revenueCents),
    });
    byProduct.set(key, row);
  }

  const total = { quantity: 0, revenueCents: 0, purchaseCostCents: 0 };
  const rows = [...byProduct.values()]
    .sort((a, b) => b.quantitySold - a.quantitySold || a.product.localeCompare(b.product, "fr"))
    .map((row) => {
      total.quantity += row.quantitySold;
      total.revenueCents += row.revenueCents;
      total.purchaseCostCents += row.purchaseCostCents;
      row.prices.sort((a, b) => (b.unitPrice.fc ?? 0) - (a.unitPrice.fc ?? 0));
      const base = {
        productId: row.productId, product: row.product, category: row.category, unit: row.unit,
        prices: row.prices,
        quantitySold: row.quantitySold,
        revenue: fcMoney(row.revenueCents),
      };
      if (!financials) return base;
      return {
        ...base,
        purchaseCost: fcMoney(row.purchaseCostCents),
        profit: fcMoney(row.revenueCents - row.purchaseCostCents),
      };
    });
  const summary = {
    skusSold: rows.length,
    unitsSold: total.quantity,
    revenue: fcMoney(total.revenueCents),
    ...(financials ? {
      purchaseCost: fcMoney(total.purchaseCostCents),
      profit: fcMoney(total.revenueCents - total.purchaseCostCents),
    } : {}),
  };
  return { rows, summary, currency: "FC", financialsVisible: Boolean(financials) };
}

async function salesSheet(req, res) {
  try {
    const category = reportCategory(req);
    const range = reportRange(req);
    const report = await buildSalesSheet({
      categories: category ? [category] : CATEGORIES, start: range.$gte, end: range.$lte,
      financials: canViewFinancials(req.user),
    });
    res.set("Cache-Control", "no-store");
    return res.json({
      source: "recognized-sales-aggregation",
      category: category || "ALL",
      period: { start: range.$gte, end: range.$lte },
      ...report,
    });
  } catch (error) {
    return sendReportError(res, error, "Sales sheet");
  }
}

module.exports = {
  buildSalesSheet, buildStockSheet, inventoryValue, productStockSheet, reportCategory,
  salesSheet, sellingPriceOf, stockSheet,
};
