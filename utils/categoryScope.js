const VALID_CATEGORIES = new Set(["CLOTHES", "SHOES"]);

function historicalRate() {
  return { $ifNull: ["$items.exchangeRate", { $ifNull: ["$exchangeRate", 0] }] };
}
// Exact FC unit price of a line: the entered FC amount, else the FC snapshot.
function unitPriceFC() {
  return { $cond: [{ $eq: ["$items.enteredCurrency", "FC"] }, "$items.enteredPrice", "$items.priceFC"] };
}
// Legacy lines without revenueFC use their exact FC unit snapshot before ever
// converting the cent-rounded USD revenue (which would drift 20,000 -> 20,007).
function revenueFC() {
  return { $ifNull: ["$items.revenueFC", { $ifNull: [
    { $multiply: [unitPriceFC(), "$items.quantity"] },
    { $multiply: [{ $ifNull: ["$items.revenue", 0] }, historicalRate()] },
  ] }] };
}
function cogsFC() {
  return { $ifNull: ["$items.costOfGoodsSoldFC", { $multiply: [{ $ifNull: ["$items.costOfGoodsSold", 0] }, historicalRate()] }] };
}
function grossFC() {
  return { $ifNull: ["$items.grossProfitFC", { $subtract: [revenueFC(), cogsFC()] }] };
}
function clothesShare() {
  return { $ifNull: ["$items.clothesShareholderProfit", { $cond: [{ $eq: ["$items.mainCategory", "CLOTHES"] }, { $ifNull: ["$items.grossProfit", 0] }, 0] }] };
}
function shoeShare() {
  return { $cond: [{ $eq: ["$items.mainCategory", "SHOES"] }, { $divide: [{ $ifNull: ["$items.grossProfit", 0] }, 2] }, 0] };
}
function clothesShareFC() {
  return { $ifNull: ["$items.clothesShareholderProfitFC", { $cond: [{ $eq: ["$items.mainCategory", "CLOTHES"] }, grossFC(), 0] }] };
}
function shoeShareFC() {
  return { $cond: [{ $eq: ["$items.mainCategory", "SHOES"] }, { $divide: [grossFC(), 2] }, 0] };
}

function categoryRestrictedSaleStages(category) {
  if (!VALID_CATEGORIES.has(category)) return [];
  return [
    { $match: { "items.mainCategory": category } },
    { $unwind: "$items" },
    { $match: { "items.mainCategory": category } },
    { $set: {
      "items.revenueFC": revenueFC(),
      "items.costOfGoodsSoldFC": cogsFC(),
      "items.grossProfitFC": grossFC(),
      "items.clothesShareholderProfit": clothesShare(),
      "items.shoeShareholder1Profit": { $ifNull: ["$items.shoeShareholder1Profit", shoeShare()] },
      "items.shoeShareholder2Profit": { $ifNull: ["$items.shoeShareholder2Profit", shoeShare()] },
      "items.clothesShareholderProfitFC": clothesShareFC(),
      "items.shoeShareholder1ProfitFC": { $ifNull: ["$items.shoeShareholder1ProfitFC", shoeShareFC()] },
      "items.shoeShareholder2ProfitFC": { $ifNull: ["$items.shoeShareholder2ProfitFC", shoeShareFC()] },
    } },
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
