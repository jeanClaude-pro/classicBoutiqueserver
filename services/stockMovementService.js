const StockMovement = require("../models/StockMovement");
const Product = require("../models/Product");

// Movements always take the server clock unless a caller passes an explicit
// time (only product creation does, to align INITIAL with Product.createdAt).
async function recordStockMovement({ product, quantityDelta, balanceBefore, balanceAfter, kind, sourceId, occurredAt, createdBy, session, mainCategory }) {
  const row = {
    productId: product._id,
    productName: product.name,
    mainCategory: mainCategory || product.mainCategory,
    unit: product.unit || "pcs",
    quantityDelta,
    balanceBefore,
    balanceAfter,
    kind,
    sourceId,
    occurredAt: occurredAt || new Date(),
    createdBy,
  };
  const created = await StockMovement.create([row], session ? { session } : undefined);
  return created[0];
}

// Records a product edit: an optional category transfer followed by an
// optional quantity adjustment, each in the right category stream.
async function recordProductEditMovements({ before, after, createdBy, session }) {
  const sourceId = String(after._id);
  const now = new Date();
  if (before.mainCategory !== after.mainCategory) {
    await recordStockMovement({
      product: after, mainCategory: before.mainCategory, quantityDelta: -before.stock,
      balanceBefore: before.stock, balanceAfter: 0, kind: "CATEGORY_TRANSFER_OUT",
      sourceId, occurredAt: now, createdBy, session,
    });
    await recordStockMovement({
      product: after, mainCategory: after.mainCategory, quantityDelta: before.stock,
      balanceBefore: 0, balanceAfter: before.stock, kind: "CATEGORY_TRANSFER_IN",
      sourceId, occurredAt: now, createdBy, session,
    });
  }
  if (after.stock !== before.stock) {
    await recordStockMovement({
      product: after, quantityDelta: after.stock - before.stock,
      balanceBefore: before.stock, balanceAfter: after.stock, kind: "MANUAL_ADJUSTMENT",
      sourceId, occurredAt: now, createdBy, session,
    });
  }
}

// One-time forward-looking baseline for products that predate the ledger.
// It deliberately uses the migration time: periods before this point are
// reported as incomplete instead of pretending the current balance is old history.
async function ensureStockBaselines() {
  const tracked = await StockMovement.distinct("productId");
  const products = await Product.find({ _id: { $nin: tracked }, mainCategory: { $in: ["CLOTHES", "SHOES"] } }).select("name mainCategory unit stock").lean();
  if (!products.length) return 0;
  const occurredAt = new Date();
  await StockMovement.insertMany(products.map((product) => ({
    productId: product._id,
    productName: product.name,
    mainCategory: product.mainCategory,
    unit: product.unit || "pcs",
    quantityDelta: 0,
    balanceBefore: product.stock,
    balanceAfter: product.stock,
    kind: "BASELINE",
    sourceId: `baseline:${product._id}`,
    occurredAt,
  })), { ordered: false });
  return products.length;
}

module.exports = { ensureStockBaselines, recordProductEditMovements, recordStockMovement };
