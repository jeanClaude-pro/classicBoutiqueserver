const VALID_CATEGORIES = new Set(["CLOTHES", "SHOES"]);

// Sale aggregations are presented in FC before these stages run (see the
// Sale model hook and utils/currency.js), so every canonical money field of
// a line is already in francs, historical records included.
function categoryRestrictedSaleStages(category) {
  if (!VALID_CATEGORIES.has(category)) return [];
  return [
    { $match: { "items.mainCategory": category } },
    { $unwind: "$items" },
    { $match: { "items.mainCategory": category } },
    { $group: { _id: "$_id", sale: { $first: "$$ROOT" }, authorizedItems: { $push: "$items" } } },
    { $set: {
      "sale.items": "$authorizedItems",
      "sale.subtotal": { $sum: "$authorizedItems.revenue" },
      "sale.total": { $sum: "$authorizedItems.revenue" },
      "sale.totalRevenue": { $sum: "$authorizedItems.revenue" },
      "sale.totalRevenueFC": { $sum: "$authorizedItems.revenueFC" },
      "sale.costOfGoodsSold": { $sum: "$authorizedItems.costOfGoodsSold" },
      "sale.costOfGoodsSoldFC": { $sum: "$authorizedItems.costOfGoodsSoldFC" },
      "sale.grossProfit": { $sum: "$authorizedItems.grossProfit" },
      "sale.grossProfitFC": { $sum: "$authorizedItems.grossProfitFC" },
      "sale.clothesShareholderProfit": { $sum: "$authorizedItems.clothesShareholderProfit" },
      "sale.shoeShareholder1Profit": { $sum: "$authorizedItems.shoeShareholder1Profit" },
      "sale.shoeShareholder2Profit": { $sum: "$authorizedItems.shoeShareholder2Profit" },
      "sale.clothesShareholderProfitFC": { $sum: "$authorizedItems.clothesShareholderProfitFC" },
      "sale.shoeShareholder1ProfitFC": { $sum: "$authorizedItems.shoeShareholder1ProfitFC" },
      "sale.shoeShareholder2ProfitFC": { $sum: "$authorizedItems.shoeShareholder2ProfitFC" },
      "sale.authorizedCategory": category,
    } },
    { $replaceRoot: { newRoot: "$sale" } },
    { $project: { shopProfit: 0, partnerProfit: 0, "items.shopProfit": 0, "items.partnerProfit": 0 } },
  ];
}

module.exports = { categoryRestrictedSaleStages };
