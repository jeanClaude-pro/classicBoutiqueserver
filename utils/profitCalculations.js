const MAIN_CATEGORIES = Object.freeze(["CLOTHES", "SHOES"]);

function finiteNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${fieldName} must be a finite number`);
  }
  return number;
}

function toCents(value, fieldName) {
  return Math.round(finiteNumber(value, fieldName) * 100);
}

function fromCents(cents) {
  return Number((cents / 100).toFixed(2));
}

function normalizeQuantity(value, fieldName = "quantity") {
  const quantity = finiteNumber(value, fieldName);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError(`${fieldName} must be a positive integer`);
  }
  return quantity;
}

function normalizeMainCategory(value) {
  const category = String(value || "").trim().toUpperCase();
  if (!MAIN_CATEGORIES.includes(category)) {
    throw new RangeError("mainCategory must be CLOTHES or SHOES");
  }
  return category;
}

// The user always enters the acquisition cost of ONE piece. The batch total
// is a pure multiplication, never a division — dividing here would silently
// reinterpret a per-piece price as if it were the whole batch's cost.
function calculateTotalAcquisitionValue(unitCost, purchasedQuantity) {
  const unitCostCents = toCents(unitCost, "unitCost");
  const quantity = normalizeQuantity(purchasedQuantity, "purchasedQuantity");
  if (unitCostCents < 0) {
    throw new RangeError("unitCost cannot be negative");
  }
  return fromCents(unitCostCents * quantity);
}

function calculateProfitSnapshot({
  unitSellingPrice,
  unitAcquisitionCost,
  unitSellingPriceFC,
  unitAcquisitionCostFC,
  quantity,
  mainCategory,
}) {
  const soldQuantity = normalizeQuantity(quantity);
  const category = normalizeMainCategory(mainCategory);
  const sellingPriceCents = toCents(unitSellingPrice, "unitSellingPrice");
  if (sellingPriceCents < 0) {
    throw new RangeError("unitSellingPrice cannot be negative");
  }

  const acquisitionCost = finiteNumber(unitAcquisitionCost, "unitAcquisitionCost");
  if (acquisitionCost < 0) {
    throw new RangeError("unitAcquisitionCost cannot be negative");
  }

  const revenueCents = sellingPriceCents * soldQuantity;
  const costOfGoodsSoldCents = Math.round(acquisitionCost * 100 * soldQuantity);
  const grossProfitCents = revenueCents - costOfGoodsSoldCents;
  let clothesShareholderProfitCents = grossProfitCents;
  let shoeShareholder1ProfitCents = 0;
  let shoeShareholder2ProfitCents = 0;
  let shareholderAllocationRule = "CLOTHES_OWNER_100";

  if (category === "SHOES") {
    clothesShareholderProfitCents = 0;
    // Canonical shareholder entitlements are mathematically equal. A half-cent
    // is retained as a decimal when necessary instead of assigning a rounding
    // remainder to either owner.
    shoeShareholder1ProfitCents = grossProfitCents / 2;
    shoeShareholder2ProfitCents = grossProfitCents / 2;
    shareholderAllocationRule = "SHOES_OWNERS_50_50";
  }

  const clothesShareholderProfit = clothesShareholderProfitCents / 100;
  const shoeShareholder1Profit = shoeShareholder1ProfitCents / 100;
  const shoeShareholder2Profit = shoeShareholder2ProfitCents / 100;

  const fcSnapshot = {};
  if (unitSellingPriceFC !== undefined && unitAcquisitionCostFC !== undefined) {
    const sellingFC = finiteNumber(unitSellingPriceFC, "unitSellingPriceFC");
    const acquisitionFC = finiteNumber(unitAcquisitionCostFC, "unitAcquisitionCostFC");
    const revenueFC = sellingFC * soldQuantity;
    const costOfGoodsSoldFC = acquisitionFC * soldQuantity;
    const grossProfitFC = revenueFC - costOfGoodsSoldFC;
    fcSnapshot.unitSellingPriceFC = sellingFC;
    fcSnapshot.unitAcquisitionCostFC = acquisitionFC;
    fcSnapshot.revenueFC = Number(revenueFC.toFixed(6));
    fcSnapshot.costOfGoodsSoldFC = Number(costOfGoodsSoldFC.toFixed(6));
    fcSnapshot.grossProfitFC = Number(grossProfitFC.toFixed(6));
    fcSnapshot.clothesShareholderProfitFC = category === "CLOTHES" ? fcSnapshot.grossProfitFC : 0;
    fcSnapshot.shoeShareholder1ProfitFC = category === "SHOES" ? Number((grossProfitFC / 2).toFixed(6)) : 0;
    fcSnapshot.shoeShareholder2ProfitFC = category === "SHOES" ? Number((grossProfitFC / 2).toFixed(6)) : 0;
  }

  return {
    unitSellingPrice: fromCents(sellingPriceCents),
    unitAcquisitionCost: Number(acquisitionCost.toFixed(6)),
    quantity: soldQuantity,
    revenue: fromCents(revenueCents),
    costOfGoodsSold: fromCents(costOfGoodsSoldCents),
    grossProfit: fromCents(grossProfitCents),
    clothesShareholderProfit,
    shoeShareholder1Profit,
    shoeShareholder2Profit,
    shareholderAllocationRule,
    // Compatibility aliases for historical consumers. New reporting must use
    // the explicit shareholder fields above.
    shopProfit: category === "CLOTHES" ? clothesShareholderProfit : shoeShareholder1Profit,
    partnerProfit: shoeShareholder2Profit,
    mainCategory: category,
    profitAllocationRule: category === "CLOTHES" ? "SHOP_100" : "SHOES_50_50",
    ...fcSnapshot,
  };
}

function sumFinancialSnapshots(items = []) {
  const fields = ["revenue", "costOfGoodsSold", "grossProfit", "shopProfit", "partnerProfit"];
  const totals = fields.reduce((totals, field) => {
    totals[field === "revenue" ? "totalRevenue" : field] = fromCents(
      items.reduce((sum, item) => sum + toCents(item[field] || 0, field), 0)
    );
    return totals;
  }, {
    clothesShareholderProfit: Number(items.reduce((sum, item) => sum + Number(item.clothesShareholderProfit || 0), 0).toFixed(6)),
    shoeShareholder1Profit: Number(items.reduce((sum, item) => sum + Number(item.shoeShareholder1Profit || 0), 0).toFixed(6)),
    shoeShareholder2Profit: Number(items.reduce((sum, item) => sum + Number(item.shoeShareholder2Profit || 0), 0).toFixed(6)),
  });
  const fcFields = ["revenueFC", "costOfGoodsSoldFC", "grossProfitFC", "clothesShareholderProfitFC", "shoeShareholder1ProfitFC", "shoeShareholder2ProfitFC"];
  if (items.some((item) => item.revenueFC !== undefined)) {
    for (const field of fcFields) {
      totals[field === "revenueFC" ? "totalRevenueFC" : field] = Number(items.reduce((sum, item) => sum + Number(item[field] || 0), 0).toFixed(6));
    }
  }
  return totals;
}

module.exports = {
  MAIN_CATEGORIES,
  calculateProfitSnapshot,
  calculateTotalAcquisitionValue,
  normalizeMainCategory,
  normalizeQuantity,
  sumFinancialSnapshots,
};
