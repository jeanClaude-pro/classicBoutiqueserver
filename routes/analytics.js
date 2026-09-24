const express = require("express");
const Sale = require("../models/Sale");
const Entry = require("../models/Entry");
const Expense = require("../models/Expense");
const Creditor = require("../models/Creditor");
const Loan = require("../models/Loan");
const Product = require("../models/Product");
const authMiddleware = require("../middleware/auth");
const { requireRole } = require("../middleware/security");
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
const {
  CATEGORIES,
  buildCategoryReport,
} = require("../services/financialAccountingService");
const { getFallbackExchangeRate } = require("../utils/currentExchangeRate");
const { productNormalPriceUSDExpression } = require("../utils/salePricing");

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole("superadmin", "admin"));
const visibleTimeframeQuery = (req) => ["admin", "superadmin"].includes(req.user?.role) ? req.query : {};
const expenseSign = { $cond: [{ $eq: ["$transactionKind", "REVERSAL"] }, -1, 1] };
const signedExpenseUSD = { $multiply: [expenseSign, { $ifNull: ["$amountUSD", "$amount"] }] };

// Activity metrics (sales count, cash taken at the till) include pending
// reservations because their money has been received. Accounting figures -
// revenue, COGS, profit, funds, shareholder shares - come exclusively from
// financialAccountingService, which recognizes a sale once, on completion.
const VALID_SALE_MATCH = {
  type: { $in: ["sale", "reservation"] },
  status: { $in: ["completed", "pending"] },
};

const sumRows = (rows, field) => rows.reduce((sum, row) => sum + Math.round(Number(row[field] || 0) * 100), 0) / 100;

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

async function aggregatePeriod(createdAt, category = null, { withAccounting = true } = {}) {
  const saleMatch = { ...VALID_SALE_MATCH, createdAt };
  const accountingCategories = category ? [category] : CATEGORIES;
  const [salesResult, entryResult, expenseResult, categoryReports] = await Promise.all([
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
              pendingReservationAmount: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, "$total", 0] } },
            },
          }],
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
                revenue: { $sum: { $ifNull: ["$items.revenue", { $multiply: [{ $ifNull: ["$items.priceUSD", "$items.price"] }, "$items.quantity"] }] } },
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
    // Cash-out workflow statistics. Unclassified legacy cash-outs stay in the
    // global totals and are never attributed to CLOTHES or SHOES.
    Expense.aggregate([
      { $match: { createdAt, ...(category ? { category } : {}) } },
      {
        $facet: {
          validated: [
            { $match: { status: "validated" } },
            { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: signedExpenseUSD } } },
          ],
          statuses: [
            { $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: signedExpenseUSD } } },
          ],
        },
      },
    ]),
    withAccounting
      ? Promise.all(accountingCategories.map((name) => buildCategoryReport(name, createdAt)))
      : Promise.resolve([]),
  ]);

  const salesFacet = salesResult[0] || {};
  const sales = salesFacet.metrics?.[0] || {
    totalSales: 0,
    totalRevenue: 0,
    reservations: 0,
    pendingReservationAmount: 0,
  };
  const categoryBreakdown = Object.fromEntries(categoryReports.map((report) => [report.category, report]));
  const entries = entryResult[0] || { count: 0, amount: 0 };
  const expenseFacet = expenseResult[0] || {};
  const validatedExpenses = expenseFacet.validated?.[0] || { count: 0, amount: 0 };

  return {
    totalSales: sales.totalSales,
    totalRevenue: sales.totalRevenue,
    reservationCount: sales.reservations,
    pendingReservationAmount: sales.pendingReservationAmount || 0,
    realizedRevenue: sumRows(categoryReports, "revenue"),
    costOfGoodsSold: sumRows(categoryReports, "costOfGoodsSold"),
    grossProfit: sumRows(categoryReports, "grossProfit"),
    clothesShareholderProfit: categoryBreakdown.CLOTHES?.distributableProfit || 0,
    shoeShareholder1Profit: categoryBreakdown.SHOES?.shareholder1 || 0,
    shoeShareholder2Profit: categoryBreakdown.SHOES?.shareholder2 || 0,
    costOfGoodsSoldFC: sumRows(categoryReports, "costOfGoodsSoldFC"),
    grossProfitFC: sumRows(categoryReports, "grossProfitFC"),
    clothesShareholderProfitFC: categoryBreakdown.CLOTHES?.distributableProfitFC || 0,
    shoeShareholder1ProfitFC: categoryBreakdown.SHOES?.shareholder1FC || 0,
    shoeShareholder2ProfitFC: categoryBreakdown.SHOES?.shareholder2FC || 0,
    categoryBreakdown,
    totalCompanyExpenses: sumRows(categoryReports, "companyExpenses"),
    totalGoodsPurchases: sumRows(categoryReports, "goodsPurchases"),
    totalNetProfit: sumRows(categoryReports, "netProfit"),
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
    Expense.aggregate([{ $match: { expenseType: { $in: ["REPAYMENT", "repayment"] }, status: "validated", repaymentAppliedAt: range } }, { $group: { _id: null, amount: { $sum: "$amountUSD" }, count: { $sum: 1 } } }]),
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
    const filter = buildTimeframeFilter(visibleTimeframeQuery(req));
    const currentRange = filter.createdAt;
    const priorRange = previousRange(currentRange);
    const chart = chartConfiguration(timeframe, currentRange);
    const dateTrunc = {
      date: "$createdAt",
      unit: chart.unit,
      timezone: BUSINESS_TIMEZONE,
    };
    if (chart.unit === "week") dateTrunc.startOfWeek = "monday";

    const visibleCategories = category ? [category] : CATEGORIES;
    const currentRate = await getFallbackExchangeRate();
    const [current, previous, chartRows, debt, inventoryRows] = await Promise.all([
      aggregatePeriod(currentRange, category),
      aggregatePeriod(priorRange, category, { withAccounting: false }),
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
      Product.aggregate([
        { $match: { status: "active", mainCategory: { $in: visibleCategories } } },
        { $group: {
          _id: "$mainCategory",
          products: { $sum: 1 },
          unitsInStock: { $sum: "$stock" },
          acquisitionValue: { $sum: { $multiply: ["$stock", "$unitCost"] } },
          retailValue: { $sum: { $multiply: ["$stock", productNormalPriceUSDExpression(currentRate)] } },
        } },
      ]),
    ]);

    current.inventoryValuation = Object.fromEntries(inventoryRows.map((row) => [row._id, {
      products: row.products,
      unitsInStock: row.unitsInStock,
      acquisitionValue: row.acquisitionValue,
      retailValue: row.retailValue,
    }]));

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
      realizedRevenue: current.realizedRevenue,
      costOfGoodsSold: current.costOfGoodsSold,
      costOfGoodsSoldFC: current.costOfGoodsSoldFC,
      grossProfit: current.grossProfit,
      grossProfitFC: current.grossProfitFC,
      shareholderEntitlement: category === "CLOTHES"
        ? current.categoryBreakdown?.[category]?.distributableProfit || 0
        : current.categoryBreakdown?.[category]?.shareholder1 || 0,
      shareholderEntitlementFC: category === "CLOTHES"
        ? current.categoryBreakdown?.[category]?.distributableProfitFC || 0
        : current.categoryBreakdown?.[category]?.shareholder1FC || 0,
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
