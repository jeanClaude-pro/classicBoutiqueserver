/*
 * One-time migration for inherited products.
 *
 * Usage:
 *   node scripts/migrateBoutiqueProducts.js path/to/product-financials.json
 *
 * JSON shape:
 * {
 *   "<mongo product id>": {
 *     "mainCategory": "CLOTHES",
 *     "subcategory": "Robes",
 *     "purchasedQuantity": 10,
 *     "totalAcquisitionCost": 200
 *   }
 * }
 *
 * totalAcquisitionCost here is the known TOTAL historical cost of that
 * batch (inherited records only have that figure, not a per-piece price),
 * so it is divided by purchasedQuantity to recover unitCost, then the
 * canonical calculateTotalAcquisitionValue re-derives totalAcquisitionCost
 * from that unitCost so the stored figure uses the same cent-rounding as
 * every other product in the system.
 *
 * The script deliberately requires explicit acquisition data. Guessing an
 * inherited cost from today's selling price would corrupt future profit.
 */
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const Product = require("../models/Product");
const ShopSettings = require("../models/ShopSettings");
const {
  calculateTotalAcquisitionValue,
  normalizeMainCategory,
  normalizeQuantity,
} = require("../utils/profitCalculations");

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("Pass the product-financials.json path");
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  const records = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
  await mongoose.connect(process.env.MONGO_URI);

  let updated = 0;
  for (const [productId, input] of Object.entries(records)) {
    const mainCategory = normalizeMainCategory(input.mainCategory);
    const purchasedQuantity = normalizeQuantity(input.purchasedQuantity, "purchasedQuantity");
    const inheritedTotal = Number(input.totalAcquisitionCost);
    if (!Number.isFinite(inheritedTotal) || inheritedTotal < 0) {
      throw new RangeError(`totalAcquisitionCost must be zero or greater for ${productId}`);
    }
    const unitCost = Number((inheritedTotal / purchasedQuantity).toFixed(6));
    const totalAcquisitionCost = calculateTotalAcquisitionValue(unitCost, purchasedQuantity);
    const result = await Product.updateOne(
      { _id: productId },
      {
        $set: {
          mainCategory,
          subcategory: String(input.subcategory || "").trim(),
          category: String(input.subcategory || mainCategory).trim(),
          purchasedQuantity,
          totalAcquisitionCost,
          unitCost,
        },
      },
      { runValidators: true }
    );
    if (!result.matchedCount) throw new Error(`Product not found: ${productId}`);
    updated += result.modifiedCount;
  }
  await ShopSettings.findOneAndUpdate(
    {},
    {
      $set: {
        shopName: "ETS DOUBLE M CLASSIC BOUTIQUE",
        shopAddress: "780 AV. Du 30 Juin Coin Tabora, Q/MAKUTANO, C/Lubumbashi",
        shopNumber: "+243 836 017 031",
        shopRegistration: "LSH/RCCM/22-A-01266",
      },
    },
    { upsert: true, runValidators: true }
  );
  console.log(`Migration complete: ${updated} product(s) updated.`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
