const mongoose = require("mongoose");
const Product = require("../models/Product");
const Sale = require("../models/Sale");
const StockMovement = require("../models/StockMovement");
const { buildTimeframeFilter } = require("../utils/queryHelpers");
const { recognizedSaleMatch, saleLineAmountExpressions } = require("../services/financialAccountingService");
const { isShareholderAdmin, isSuperadmin } = require("../middleware/authorization");
const { productNormalPrice } = require("../utils/salePricing");
const { getFallbackExchangeRate } = require("../utils/currentExchangeRate");

const CATEGORIES = ["CLOTHES", "SHOES"];
const SALE_KINDS = ["SALE", "SALE_CORRECTION", "SALE_VOID", "SALE_DELETE"];
// A category stream that starts with one of these did not exist before it.
const STREAM_OPENERS = ["INITIAL", "CATEGORY_TRANSFER_IN"];
// A stream whose last movement is one of these holds nothing any more.
const STREAM_CLOSERS = ["PRODUCT_DELETE", "CATEGORY_TRANSFER_OUT"];
const PRICE_FIELDS = "name unit status mainCategory subcategory brand stock price priceEnteredAmount priceEnteredCurrency priceFC priceExchangeRate";

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

// Current normal selling price of a product, in its authoritative currency
// (utils/salePricing.productNormalPrice): an FC-defined price stays exact in
// FC, a USD-defined price stays exact in USD; only the other currency follows
// today's rate. Read-only: nothing is written back to the product.
function sellingPriceOf(product, rate) {
  if (!product) return null;
  const normal = productNormalPrice(product, rate);
  if (!Number.isFinite(normal.usd) && !Number.isFinite(normal.fc)) return null;
  return {
    currency: normal.currency,
    usd: Number.isFinite(normal.usd) ? cents(normal.usd) / 100 : null,
    fc: Number.isFinite(normal.fc) ? Math.round(normal.fc) : null,
  };
}

// Inventory value at selling price = quantity x current unit selling price,
// computed in the authoritative currency first (exact), the other currency
// derived from it. This is a valuation of unsold stock, never revenue.
function inventoryValue(quantity, price, rate) {
  if (typeof quantity !== "number" || !price) return null;
  if (price.currency === "FC" && price.fc !== null) {
    const fc = quantity * price.fc;
    return { fc, usd: rate ? cents(fc / rate) / 100 : null };
  }
  if (price.usd === null) return null;
  const usdCents = quantity * cents(price.usd);
  return { usd: usdCents / 100, fc: price.fc !== null ? quantity * price.fc : null };
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
  const [beforeRows, withinRows, trackedIds, rate] = await Promise.all([
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
    getFallbackExchangeRate(),
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
    const sellingPrice = row.status === "deleted" ? null : sellingPriceOf(product, rate);
    return { ...row, sellingPrice, inventoryValue: inventoryValue(row.closingStock, sellingPrice, rate) };
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
    inventoryValueUSDCents: sum.inventoryValueUSDCents + (row.inventoryValue?.usd != null ? cents(row.inventoryValue.usd) : 0),
    inventoryValueFC: sum.inventoryValueFC + (row.inventoryValue?.fc ?? 0),
  }), { openingStock: 0, additions: 0, reductions: 0, salesOut: 0, closingStock: 0, inventoryValueUSDCents: 0, inventoryValueFC: 0 });
  const { inventoryValueUSDCents, inventoryValueFC, ...quantities } = totals;
  return {
    rows,
    totals: { ...quantities, inventoryValue: { usd: inventoryValueUSDCents / 100, fc: Math.round(inventoryValueFC) } },
    exchangeRate: rate || null,
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
      exchangeRate: report.exchangeRate,
      product: {
        productId: String(product._id),
        name: product.name,
        category: product.mainCategory,
        subcategory: product.subcategory || "",
        brand: product.brand || "",
        unit: product.unit || "pcs",
        status: product.status,
        currentStock: product.stock,
        sellingPrice: sellingPriceOf(product, report.exchangeRate),
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
// so revenue = purchase cost + profit holds exactly (integer cents / FC).
async function buildSalesSheet({ categories, start, end, financials }) {
  const range = { $gte: start, $lte: end };
  const line = saleLineAmountExpressions();
  // The unit price each line was actually sold at, in the currency it was
  // entered in (exact FC stays exact FC; discounts and family prices included).
  const soldInFC = { $eq: ["$items.enteredCurrency", "FC"] };
  const unitPrice = {
    $cond: [
      soldInFC,
      { $ifNull: ["$items.enteredPrice", "$items.priceFC"] },
      { $round: [{ $cond: [{ $eq: ["$items.enteredCurrency", "USD"] }, { $ifNull: ["$items.enteredPrice", "$items.priceUSD"] }, { $ifNull: ["$items.priceUSD", "$items.price"] }] }, 2] },
    ],
  };
  const grouped = await Sale.aggregate([
    { $match: recognizedSaleMatch({ $in: categories }, range) },
    { $unwind: "$items" },
    { $match: { "items.mainCategory": { $in: categories } } },
    { $group: {
      _id: {
        productId: "$items.productId",
        category: "$items.mainCategory",
        currency: { $cond: [soldInFC, "FC", "USD"] },
        unitPrice,
      },
      name: { $last: "$items.name" },
      quantity: { $sum: "$items.quantity" },
      revenueCents: { $sum: line.revenueCents },
      purchaseCostCents: { $sum: line.cogsCents },
      revenueFC: { $sum: line.revenueFC },
      purchaseCostFC: { $sum: line.cogsFC },
    } },
    { $lookup: { from: "products", localField: "_id.productId", foreignField: "_id", as: "product" } },
    { $project: {
      _id: 0,
      productId: { $toString: "$_id.productId" },
      product: { $ifNull: [{ $arrayElemAt: ["$product.name", 0] }, "$name"] },
      category: "$_id.category",
      unit: { $ifNull: [{ $arrayElemAt: ["$product.unit", 0] }, "pcs"] },
      currency: "$_id.currency",
      unitPrice: "$_id.unitPrice",
      quantity: 1, revenueCents: 1, purchaseCostCents: 1, revenueFC: 1, purchaseCostFC: 1,
    } },
  ]).allowDiskUse(true);

  // One row per product (and category): every price it was sold at with the
  // pieces that left at that price, then the product's totals.
  const byProduct = new Map();
  for (const group of grouped) {
    const key = `${group.productId}:${group.category}`;
    const row = byProduct.get(key) ?? {
      productId: group.productId, product: group.product, category: group.category, unit: group.unit,
      quantitySold: 0, revenueCents: 0, purchaseCostCents: 0, revenueFC: 0, purchaseCostFC: 0, prices: [],
    };
    const revenueFC = Math.round(group.revenueFC);
    row.quantitySold += group.quantity;
    row.revenueCents += group.revenueCents;
    row.purchaseCostCents += group.purchaseCostCents;
    row.revenueFC += revenueFC;
    row.purchaseCostFC += Math.round(group.purchaseCostFC);
    row.prices.push({
      currency: group.currency,
      // The sold unit price in its own currency, and its equivalent.
      unitPrice: group.currency === "FC"
        ? { fc: group.unitPrice, usd: Math.round(group.revenueCents / group.quantity) / 100 }
        : { usd: group.unitPrice, fc: Math.round(revenueFC / group.quantity) },
      quantity: group.quantity,
      revenue: { usd: group.revenueCents / 100, fc: revenueFC },
    });
    byProduct.set(key, row);
  }

  const total = { quantity: 0, revenueCents: 0, purchaseCostCents: 0, revenueFC: 0, purchaseCostFC: 0 };
  const rows = [...byProduct.values()]
    .sort((a, b) => b.quantitySold - a.quantitySold || a.product.localeCompare(b.product, "fr"))
    .map((row) => {
      total.quantity += row.quantitySold;
      total.revenueCents += row.revenueCents;
      total.purchaseCostCents += row.purchaseCostCents;
      total.revenueFC += row.revenueFC;
      total.purchaseCostFC += row.purchaseCostFC;
      row.prices.sort((a, b) => (b.unitPrice.usd ?? 0) - (a.unitPrice.usd ?? 0));
      const base = {
        productId: row.productId, product: row.product, category: row.category, unit: row.unit,
        prices: row.prices,
        quantitySold: row.quantitySold,
        revenue: { usd: row.revenueCents / 100, fc: row.revenueFC },
      };
      if (!financials) return base;
      return {
        ...base,
        purchaseCost: { usd: row.purchaseCostCents / 100, fc: row.purchaseCostFC },
        profit: { usd: (row.revenueCents - row.purchaseCostCents) / 100, fc: row.revenueFC - row.purchaseCostFC },
      };
    });
  const summary = {
    skusSold: rows.length,
    unitsSold: total.quantity,
    revenue: { usd: total.revenueCents / 100, fc: total.revenueFC },
    ...(financials ? {
      purchaseCost: { usd: total.purchaseCostCents / 100, fc: total.purchaseCostFC },
      profit: { usd: (total.revenueCents - total.purchaseCostCents) / 100, fc: total.revenueFC - total.purchaseCostFC },
    } : {}),
  };
  return { rows, summary, financialsVisible: Boolean(financials) };
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
