const express = require("express");
const Sale = require("../models/Sale");
const Entry = require("../models/Entry");
const Expense = require("../models/Expense");
const Creditor = require("../models/Creditor");
const Loan = require("../models/Loan");
const authMiddleware = require("../middleware/auth");
const { authorizedCategory, isShareholderAdmin, isSuperadmin } = require("../middleware/authorization");
const { categoryRestrictedSaleStages } = require("../utils/categoryScope");
const {
  BUSINESS_TIMEZONE,
  businessDateStart,
  buildTimeframeFilter,
} = require("../utils/queryHelpers");
const {
  calculateNetCash,
  percentChange,
} = require("../utils/financialCalculations");

const router = express.Router();
router.use(authMiddleware);

const VALID_SALE_MATCH = {
  type: { $in: ["sale", "reservation"] },
  status: { $in: ["completed", "pending"] },
};

// A pending reservation has not been fulfilled yet and can still be voided,
// so it must never inflate recognized profit — only a completed sale's
// profit is realized. Revenue/sales-count metrics still include pending
// reservations (they reflect business activity), but COGS/gross/shop/partner
// profit are scoped to this stricter match.
const REALIZED_PROFIT_MATCH = {
  type: { $in: ["sale", "reservation"] },
  status: "completed",
};

// These expressions use immutable sale-item snapshots. The fallback branches
// make historical documents created before the explicit shareholder fields
// report correctly without joining today's Product values.
const itemClothesShareholderProfit = {
  $ifNull: ["$items.clothesShareholderProfit", {
    $cond: [{ $eq: ["$items.mainCategory", "CLOTHES"] }, { $ifNull: ["$items.grossProfit", 0] }, 0],
  }],
};
const itemShoeShareholder1Profit = {
  $ifNull: ["$items.shoeShareholder1Profit", {
    $cond: [{ $eq: ["$items.mainCategory", "SHOES"] }, { $divide: [{ $ifNull: ["$items.grossProfit", 0] }, 2] }, 0],
  }],
};
const itemShoeShareholder2Profit = {
  $ifNull: ["$items.shoeShareholder2Profit", {
    $cond: [{ $eq: ["$items.mainCategory", "SHOES"] }, { $divide: [{ $ifNull: ["$items.grossProfit", 0] }, 2] }, 0],
  }],
};
const historicalItemRate = { $ifNull: ["$items.exchangeRate", { $ifNull: ["$exchangeRate", 0] }] };
const itemRevenueFC = { $ifNull: ["$items.revenueFC", { $multiply: [{ $ifNull: ["$items.revenue", 0] }, historicalItemRate] }] };
const itemCostOfGoodsSoldFC = { $ifNull: ["$items.costOfGoodsSoldFC", { $multiply: [{ $ifNull: ["$items.costOfGoodsSold", 0] }, historicalItemRate] }] };
const itemGrossProfitFC = { $ifNull: ["$items.grossProfitFC", { $subtract: [itemRevenueFC, itemCostOfGoodsSoldFC] }] };
const itemClothesShareholderProfitFC = { $ifNull: ["$items.clothesShareholderProfitFC", { $cond: [{ $eq: ["$items.mainCategory", "CLOTHES"] }, itemGrossProfitFC, 0] }] };
const itemShoeShareholder1ProfitFC = { $ifNull: ["$items.shoeShareholder1ProfitFC", { $cond: [{ $eq: ["$items.mainCategory", "SHOES"] }, { $divide: [itemGrossProfitFC, 2] }, 0] }] };
const itemShoeShareholder2ProfitFC = { $ifNull: ["$items.shoeShareholder2ProfitFC", { $cond: [{ $eq: ["$items.mainCategory", "SHOES"] }, { $divide: [itemGrossProfitFC, 2] }, 0] }] };

function previousRange(range) {
  const duration = range.$lte.getTime() - range.$gte.getTime() + 1;
  return {
    $gte: new Date(range.$gte.getTime() - duration),
    $lte: new Date(range.$gte.getTime() - 1),
  };
}

function chartConfiguration(timeframe, currentRange) {
  const end = currentRange.$lte;
  if (timeframe === "day") {
    return { unit: "day", start: new Date(end.getTime() - 7 * 86400000 + 1) };
  }
  if (timeframe === "week") {
    return { unit: "week", start: new Date(end.getTime() - 28 * 86400000 + 1) };
  }
  if (timeframe === "month") {
    const firstChartMonth = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1)
    );
    return {
      unit: "month",
      start: businessDateStart(firstChartMonth.toISOString().slice(0, 7) + "-01"),
    };
  }
  return { unit: "month", start: currentRange.$gte };
}

async function aggregatePeriod(createdAt, category = null) {
  const saleMatch = { ...VALID_SALE_MATCH, createdAt };
  const [salesResult, entryResult, expenseResult] = await Promise.all([
    Sale.aggregate([
      { $match: saleMatch },
      ...categoryRestrictedSaleStages(category),
      {
        $facet: {
          metrics: [{
            $group: {
              _id: null,
              totalSales: { $sum: 1 },
              totalRevenue: { $sum: "$total" },
              reservations: { $sum: { $cond: [{ $eq: ["$type", "reservation"] }, 1, 0] } },
            },
          }],
          // Realized profit only counts completed sales (see REALIZED_PROFIT_MATCH).
          profitMetrics: [
            { $match: { status: "completed" } },
            { $unwind: "$items" },
            { $match: { "items.mainCategory": { $in: ["CLOTHES", "SHOES"] } } },
            {
              $group: {
                _id: null,
                costOfGoodsSold: { $sum: { $ifNull: ["$items.costOfGoodsSold", 0] } },
                grossProfit: { $sum: { $ifNull: ["$items.grossProfit", 0] } },
                clothesShareholderProfit: { $sum: itemClothesShareholderProfit },
                shoeShareholder1Profit: { $sum: itemShoeShareholder1Profit },
                shoeShareholder2Profit: { $sum: itemShoeShareholder2Profit },
                costOfGoodsSoldFC: { $sum: itemCostOfGoodsSoldFC },
                grossProfitFC: { $sum: itemGrossProfitFC },
                clothesShareholderProfitFC: { $sum: itemClothesShareholderProfitFC },
                shoeShareholder1ProfitFC: { $sum: itemShoeShareholder1ProfitFC },
                shoeShareholder2ProfitFC: { $sum: itemShoeShareholder2ProfitFC },
              },
            },
          ],
          categoryBreakdown: [
            { $match: { status: "completed" } },
            { $unwind: "$items" },
            { $match: { "items.mainCategory": { $in: ["CLOTHES", "SHOES"] } } },
            {
              $group: {
                _id: "$items.mainCategory",
                revenue: { $sum: { $ifNull: ["$items.revenue", 0] } },
                revenueFC: { $sum: itemRevenueFC },
                costOfGoodsSold: { $sum: { $ifNull: ["$items.costOfGoodsSold", 0] } },
                grossProfit: { $sum: { $ifNull: ["$items.grossProfit", 0] } },
                clothesShareholderProfit: { $sum: itemClothesShareholderProfit },
                shoeShareholder1Profit: { $sum: itemShoeShareholder1Profit },
                shoeShareholder2Profit: { $sum: itemShoeShareholder2Profit },
                costOfGoodsSoldFC: { $sum: itemCostOfGoodsSoldFC },
                grossProfitFC: { $sum: itemGrossProfitFC },
                clothesShareholderProfitFC: { $sum: itemClothesShareholderProfitFC },
                shoeShareholder1ProfitFC: { $sum: itemShoeShareholder1ProfitFC },
                shoeShareholder2ProfitFC: { $sum: itemShoeShareholder2ProfitFC },
              },
            },
          ],
          customerCount: [
            {
              $match: {
                $or: [
                  { customerId: { $ne: null } },
                  { "customer.phone": { $nin: [null, ""] } },
                ],
              },
            },
            {
              $group: {
                _id: { $ifNull: ["$customerId", "$customer.phone"] },
              },
            },
            { $count: "total" },
          ],
          products: [
            { $unwind: "$items" },
            {
              $group: {
                _id: { productId: "$items.productId", name: "$items.name" },
                quantity: { $sum: "$items.quantity" },
                revenue: { $sum: { $multiply: [{ $ifNull: ["$items.priceUSD", "$items.price"] }, "$items.quantity"] } },
              },
            },
            { $sort: { quantity: -1, revenue: -1 } },
            { $limit: 10 },
          ],
          productCount: [
            { $unwind: "$items" },
            { $group: { _id: "$items.productId" } },
            { $count: "total" },
          ],
          customers: [
            { $match: { isWalkIn: { $ne: true }, customerId: { $ne: null } } },
            {
              $group: {
                _id: "$customerId",
                name: { $last: "$customer.name" },
                purchases: { $sum: 1 },
                totalSpent: { $sum: "$total" },
              },
            },
            { $sort: { totalSpent: -1 } },
            { $limit: 5 },
          ],
          paymentMethods: [
            { $group: { _id: "$paymentMethod", count: { $sum: 1 }, amount: { $sum: "$total" } } },
            { $sort: { amount: -1 } },
          ],
        },
      },
    ]).allowDiskUse(true),
    Entry.aggregate([
      { $match: { createdAt, status: "active" } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amount" } } },
    ]),
    Expense.aggregate([
      { $match: { createdAt } },
      {
        $facet: {
          validated: [
            { $match: { status: "validated" } },
            { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amount" } } },
          ],
          statuses: [
            { $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
          ],
        },
      },
    ]),
  ]);

  const salesFacet = salesResult[0] || {};
  const sales = salesFacet.metrics?.[0] || {
    totalSales: 0,
    totalRevenue: 0,
    reservations: 0,
  };
  const profit = salesFacet.profitMetrics?.[0] || {
    costOfGoodsSold: 0,
    grossProfit: 0,
    clothesShareholderProfit: 0,
    shoeShareholder1Profit: 0,
    shoeShareholder2Profit: 0,
    costOfGoodsSoldFC: 0,
    grossProfitFC: 0,
    clothesShareholderProfitFC: 0,
    shoeShareholder1ProfitFC: 0,
    shoeShareholder2ProfitFC: 0,
  };
  const categoryRows = salesFacet.categoryBreakdown || [];
  const emptyCategoryTotals = () => ({
    revenue: 0,
    revenueFC: 0,
    costOfGoodsSold: 0,
    grossProfit: 0,
    clothesShareholderProfit: 0,
    shoeShareholder1Profit: 0,
    shoeShareholder2Profit: 0,
    costOfGoodsSoldFC: 0,
    grossProfitFC: 0,
    clothesShareholderProfitFC: 0,
    shoeShareholder1ProfitFC: 0,
    shoeShareholder2ProfitFC: 0,
  });
  const categoryBreakdown = category
    ? { [category]: emptyCategoryTotals() }
    : { CLOTHES: emptyCategoryTotals(), SHOES: emptyCategoryTotals() };
  for (const row of categoryRows) {
    if (row._id === "CLOTHES" || row._id === "SHOES") {
      categoryBreakdown[row._id] = {
        revenue: row.revenue || 0,
        revenueFC: row.revenueFC || 0,
        costOfGoodsSold: row.costOfGoodsSold || 0,
        grossProfit: row.grossProfit || 0,
        clothesShareholderProfit: row.clothesShareholderProfit || 0,
        shoeShareholder1Profit: row.shoeShareholder1Profit || 0,
        shoeShareholder2Profit: row.shoeShareholder2Profit || 0,
        costOfGoodsSoldFC: row.costOfGoodsSoldFC || 0,
        grossProfitFC: row.grossProfitFC || 0,
        clothesShareholderProfitFC: row.clothesShareholderProfitFC || 0,
        shoeShareholder1ProfitFC: row.shoeShareholder1ProfitFC || 0,
        shoeShareholder2ProfitFC: row.shoeShareholder2ProfitFC || 0,
      };
    }
  }
  const entries = entryResult[0] || { count: 0, amount: 0 };
  const expenseFacet = expenseResult[0] || {};
  const validatedExpenses = expenseFacet.validated?.[0] || { count: 0, amount: 0 };

  return {
    totalSales: sales.totalSales,
    totalRevenue: sales.totalRevenue,
    reservationCount: sales.reservations,
    costOfGoodsSold: profit.costOfGoodsSold,
    grossProfit: profit.grossProfit,
    clothesShareholderProfit: profit.clothesShareholderProfit,
    shoeShareholder1Profit: profit.shoeShareholder1Profit,
    shoeShareholder2Profit: profit.shoeShareholder2Profit,
    costOfGoodsSoldFC: profit.costOfGoodsSoldFC,
    grossProfitFC: profit.grossProfitFC,
    clothesShareholderProfitFC: profit.clothesShareholderProfitFC,
    shoeShareholder1ProfitFC: profit.shoeShareholder1ProfitFC,
    shoeShareholder2ProfitFC: profit.shoeShareholder2ProfitFC,
    categoryBreakdown,
    totalCustomers: salesFacet.customerCount?.[0]?.total || 0,
    totalProducts: salesFacet.productCount?.[0]?.total || 0,
    totalEntries: entries.amount,
    entryCount: entries.count,
    totalValidatedExpenses: validatedExpenses.amount,
    validatedExpenseCount: validatedExpenses.count,
    netCash: calculateNetCash(
      sales.totalRevenue,
      entries.amount,
      validatedExpenses.amount
    ),
    topProducts: (salesFacet.products || []).map((item) => ({
      name: item._id.name || "Article inconnu",
      quantity: item.quantity,
      revenue: item.revenue,
    })),
    topCustomers: (salesFacet.customers || []).map((item) => ({
      name: item.name || "Client inconnu",
      purchases: item.purchases,
      totalSpent: item.totalSpent,
    })),
    paymentMethods: salesFacet.paymentMethods || [],
    expenseStatuses: expenseFacet.statuses || [],
  };
}

async function aggregateDebt(range) {
  const [loanRows, repaymentRows, outstandingRows] = await Promise.all([
    Loan.aggregate([{ $match: { borrowedAt: range } }, { $lookup: { from: "creditors", localField: "creditorId", foreignField: "_id", as: "creditor" } }, { $unwind: "$creditor" }, { $group: { _id: "$creditor.type", amount: { $sum: "$amountUSD" }, count: { $sum: 1 } } }]),
    Expense.aggregate([{ $match: { expenseType: "repayment", status: "validated", repaymentAppliedAt: range } }, { $group: { _id: null, amount: { $sum: "$amountUSD" }, count: { $sum: 1 } } }]),
    Creditor.aggregate([{ $group: { _id: "$type", outstanding: { $sum: "$remainingBalance" }, borrowed: { $sum: "$totalBorrowed" }, repaid: { $sum: "$totalRepaid" }, creditors: { $sum: 1 } } }])
  ]);
  return { borrowedDuringPeriod: loanRows.reduce((sum, row) => sum + row.amount, 0), repaidDuringPeriod: repaymentRows[0]?.amount || 0, repaymentCount: repaymentRows[0]?.count || 0, currentOutstanding: outstandingRows.reduce((sum, row) => sum + row.outstanding, 0), borrowedByCreditorType: loanRows, outstandingByCreditorType: outstandingRows };
}

router.get("/summary", async (req, res) => {
  try {
    const category = authorizedCategory(req.user, req.query.category);
    const timeframe = ["day", "week", "month", "year"].includes(req.query.timeframe)
      ? req.query.timeframe
      : "day";
    const filter = buildTimeframeFilter(req.query);
    const currentRange = filter.createdAt;
    const priorRange = previousRange(currentRange);
    const chart = chartConfiguration(timeframe, currentRange);
    const dateTrunc = {
      date: "$createdAt",
      unit: chart.unit,
      timezone: BUSINESS_TIMEZONE,
    };
    if (chart.unit === "week") dateTrunc.startOfWeek = "monday";

    const [current, previous, chartRows, debt] = await Promise.all([
      aggregatePeriod(currentRange, category),
      aggregatePeriod(priorRange, category),
      Sale.aggregate([
        {
          $match: {
            ...VALID_SALE_MATCH,
            createdAt: { $gte: chart.start, $lte: currentRange.$lte },
          },
        },
        ...categoryRestrictedSaleStages(category),
        {
          $group: {
            _id: {
              $dateTrunc: dateTrunc,
            },
            sales: { $sum: 1 },
            revenue: { $sum: "$total" },
          },
        },
        { $sort: { _id: 1 } },
      ]).allowDiskUse(true),
      isSuperadmin(req.user) ? aggregateDebt(currentRange) : Promise.resolve(null),
    ]);

    const chartData = chartRows.map((row) => ({
      date: row._id,
      sales: row.sales,
      revenue: row.revenue,
    }));

    res.set("Cache-Control", "no-store");
    const shareholderData = isShareholderAdmin(req.user) ? {
      totalSales: current.totalSales,
      totalRevenue: current.totalRevenue,
      totalRevenueFC: current.categoryBreakdown?.[category]?.revenueFC || 0,
      costOfGoodsSold: current.costOfGoodsSold,
      costOfGoodsSoldFC: current.costOfGoodsSoldFC,
      grossProfit: current.grossProfit,
      grossProfitFC: current.grossProfitFC,
      shareholderEntitlement: category === "CLOTHES"
        ? current.clothesShareholderProfit
        : current.shoeShareholder1Profit,
      shareholderEntitlementFC: category === "CLOTHES"
        ? current.clothesShareholderProfitFC
        : current.shoeShareholder1ProfitFC,
      assignedCategory: category,
      entitlementRate: category === "CLOTHES" ? 1 : 0.5,
      categoryBreakdown: current.categoryBreakdown,
      topProducts: current.topProducts,
      paymentMethods: current.paymentMethods,
      chartData,
      recentTrends: {
        salesGrowth: percentChange(current.totalSales, previous.totalSales),
        revenueGrowth: percentChange(current.totalRevenue, previous.totalRevenue),
      },
    } : null;

    res.json({
      success: true,
      source: "mongodb-aggregation",
      paginated: false,
      timeframe: {
        type: timeframe,
        start: currentRange.$gte,
        end: currentRange.$lte,
        previousStart: priorRange.$gte,
        previousEnd: priorRange.$lte,
      },
      data: shareholderData || {
        ...current,
        netRevenue: current.netCash,
        chartData,
        recentTrends: {
          salesGrowth: percentChange(current.totalSales, previous.totalSales),
          revenueGrowth: percentChange(current.totalRevenue, previous.totalRevenue),
          customerGrowth: percentChange(current.totalCustomers, previous.totalCustomers),
        },
        ...(debt ? { reimbursement: debt } : {}),
      },
    });
  } catch (error) {
    if (/Invalid date|Invalid year|Invalid month|Start date/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error("Analytics aggregation failed:", error);
    res.status(500).json({ error: "Failed to calculate analytics" });
  }
});

module.exports = router;
