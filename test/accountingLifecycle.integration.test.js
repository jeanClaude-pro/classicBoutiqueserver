// End-to-end accounting lifecycle against a real MongoDB replica set:
// HTTP routes -> Sale/Expense documents -> AccountingLock -> aggregation ->
// financialAccountingService -> Analytics DTO.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { SKIP, createIntegrationContext, cents } = require("./helpers/integrationContext");
const Sale = require("../models/Sale");
const Expense = require("../models/Expense");
const Product = require("../models/Product");
const ExchangeRate = require("../models/ExchangeRate");
const { aggregateCategoryAccounting } = require("../services/financialAccountingService");
const { businessDateStart, businessDateEnd } = require("../utils/queryHelpers");

const ctx = createIntegrationContext();
test.before(ctx.setup);
test.after(ctx.teardown);
test.beforeEach(ctx.reset);
const itest = (name, fn) => test(name, { skip: SKIP }, fn);

const DAY = 24 * 60 * 60 * 1000;
const businessDay = (date) => new Date(date.getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
const TODAY = businessDay(new Date());
const PAST = businessDay(new Date(Date.now() - 40 * DAY));
const pastRange = { $gte: businessDateStart(PAST), $lte: businessDateEnd(PAST) };
const todayRange = { $gte: businessDateStart(TODAY), $lte: businessDateEnd(TODAY) };
const atPastNoon = new Date(businessDateStart(PAST).getTime() + 12 * 60 * 60 * 1000);

function assertIdentities(row) {
  assert.equal(cents(row.revenue) - cents(row.costOfGoodsSold), cents(row.grossProfit));
  assert.equal(cents(row.grossProfit) - cents(row.companyExpenses), cents(row.netProfit));
  assert.equal(cents(row.capitalUsedForPurchases) + cents(row.profitUsedForPurchases), cents(row.goodsPurchases));
  assert.equal(cents(row.shareholder1) + cents(row.shareholder2), cents(row.distributableProfit));
}

async function summary(query, role = "superadmin") {
  const response = await ctx.request("GET", `/analytics/summary?${new URLSearchParams(query)}`, { token: ctx.token(role) });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data;
}

// ---------------------------------------------------------------- sales ----

itest("1-2. cash and card sales recognize revenue, COGS and gross profit per category", async () => {
  const clothes = await ctx.product("CLOTHES", 60, 100);
  const shoes = await ctx.product("SHOES", 30, 50);
  assert.equal((await ctx.sell([{ product: clothes, quantity: 10 }])).status, 201);
  assert.equal((await ctx.sell([{ product: shoes, quantity: 4 }], { paymentMethod: "card" })).status, 201);
  assert.equal((await ctx.sell([{ product: shoes, quantity: 1 }], { paymentMethod: "mpesa" })).status, 201);

  const c = await ctx.balance("CLOTHES");
  assertIdentities(c);
  assert.deepEqual([c.revenue, c.costOfGoodsSold, c.grossProfit, c.availablePurchaseFunds], [1000, 600, 400, 1000]);
  const s = await ctx.balance("SHOES");
  assertIdentities(s);
  assert.deepEqual([s.revenue, s.recoveredCapital, s.grossProfit, s.availablePurchaseFunds], [250, 150, 100, 150]);
  assert.deepEqual([s.shareholder1, s.shareholder2], [50, 50]);
  assert.equal((await Product.findById(shoes._id)).stock, 995);
});

itest("3-4. credit sales are refused and never create replenishment funds", async () => {
  const clothes = await ctx.product("CLOTHES", 60, 100);
  const shoes = await ctx.product("SHOES", 60, 100);
  for (const paymentMethod of ["credit", "dette", "Crédit", "unpaid"]) {
    const response = await ctx.sell([{ product: clothes, quantity: 10 }, { product: shoes, quantity: 10 }], { paymentMethod });
    assert.equal(response.status, 400, paymentMethod);
    assert.match(response.body.error, /crédit/);
  }
  assert.equal(await Sale.countDocuments(), 0);
  assert.equal((await ctx.balance("CLOTHES")).availablePurchaseFunds, 0);
  assert.equal((await ctx.balance("SHOES")).availablePurchaseFunds, 0);
  assert.equal((await Product.findById(shoes._id)).stock, 1000);
});

itest("5-6. no receivable model exists: a recognized sale is always fully collected", async () => {
  // Partial or deferred payment cannot be recorded on a sale. If a
  // receivable model is ever added, this test forces the accounting to
  // recognize capital only as it is collected.
  for (const path of ["amountPaid", "amountDue", "balanceDue", "paidAmount", "debt"]) {
    assert.equal(Sale.schema.path(path), undefined, path);
  }
  assert.deepEqual(Sale.schema.path("paymentMethod").enumValues, ["cash", "card", "transfer", "other"]);
  assert.deepEqual(Sale.schema.path("status").enumValues, ["completed", "refunded", "pending", "voided", "corrected", "expense"]);
});

itest("7-9. reservations: pending is not recognized, completion recognizes once, reverting un-recognizes", async () => {
  const shoes = await ctx.product("SHOES", 60, 100);
  const created = await ctx.sell([{ product: shoes, quantity: 10 }], { type: "reservation", role: "manager" });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, "pending");
  assert.equal((await Product.findById(shoes._id)).stock, 990, "stock is reserved immediately");
  let s = await ctx.balance("SHOES");
  assert.deepEqual([s.revenue, s.availablePurchaseFunds, s.distributableProfit], [0, 0, 0]);

  const id = created.body._id;
  assert.equal((await ctx.request("PATCH", `/sales/${id}/complete`, { token: ctx.token("manager"), body: {} })).status, 200);
  assert.equal((await ctx.request("PATCH", `/sales/${id}/complete`, { token: ctx.token("manager"), body: {} })).status, 400);
  s = await ctx.balance("SHOES");
  assert.deepEqual([s.revenue, s.recoveredCapital, s.availablePurchaseFunds, s.distributableProfit], [1000, 600, 600, 400]);

  assert.equal((await ctx.request("PATCH", `/sales/${id}/pending`, { token: ctx.token("manager"), body: {} })).status, 403);
  assert.equal((await ctx.request("PATCH", `/sales/${id}/pending`, { token: ctx.token("superadmin"), body: {} })).status, 200);
  s = await ctx.balance("SHOES");
  assert.deepEqual([s.revenue, s.availablePurchaseFunds], [0, 0]);
  assert.equal((await Product.findById(shoes._id)).stock, 990, "reverting does not touch stock");

  assert.equal((await ctx.request("PATCH", `/sales/${id}/complete`, { token: ctx.token("superadmin"), body: {} })).status, 200);
  s = await ctx.balance("SHOES");
  assert.equal(s.revenue, 1000, "recognized exactly once after re-completion");
  const sale = await Sale.findById(id).lean();
  assert.deepEqual(sale.editHistory.map((entry) => entry.changes.status.to), ["completed", "pending", "completed"]);
  assert.equal(sale.items[0].costOfGoodsSold, 600, "historical snapshot untouched");
});

itest("9b. reverting a reservation whose capital was spent exposes a shortfall", async () => {
  const shoes = await ctx.product("SHOES", 60, 100);
  const created = await ctx.sell([{ product: shoes, quantity: 10 }], { type: "reservation" });
  await ctx.request("PATCH", `/sales/${created.body._id}/complete`, { token: ctx.token("superadmin"), body: {} });
  assert.equal((await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 600 })).status, 201);
  await ctx.request("PATCH", `/sales/${created.body._id}/pending`, { token: ctx.token("superadmin"), body: {} });
  const s = await ctx.balance("SHOES");
  assert.equal(s.availablePurchaseFunds, 0);
  assert.equal(s.fundingShortfall, 600);
  assert.equal((await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 1 })).status, 409);
});

itest("10b. reservation revenue is recognized in the period it is completed", async () => {
  const shoes = await ctx.product("SHOES", 60, 100);
  const created = await ctx.sell([{ product: shoes, quantity: 1 }], { type: "reservation" });
  await ctx.backdate(Sale, created.body._id, atPastNoon);
  await ctx.request("PATCH", `/sales/${created.body._id}/complete`, { token: ctx.token("superadmin"), body: {} });
  assert.equal((await aggregateCategoryAccounting("SHOES", { range: pastRange })).revenue, 0);
  assert.equal((await aggregateCategoryAccounting("SHOES", { range: todayRange })).revenue, 100);
});

itest("10-11. voided sales stop contributing, restore stock, and cannot be voided twice", async () => {
  const clothes = await ctx.product("CLOTHES", 60, 100);
  const sale = await ctx.sell([{ product: clothes, quantity: 10 }]);
  assert.equal((await ctx.request("PATCH", `/sales/${sale.body._id}/void`, { token: ctx.token("manager"), body: {} })).status, 403);
  assert.equal((await ctx.request("PATCH", `/sales/${sale.body._id}/void`, { token: ctx.token("superadmin"), body: { reason: "refund" } })).status, 200);
  assert.equal((await ctx.request("PATCH", `/sales/${sale.body._id}/void`, { token: ctx.token("superadmin"), body: {} })).status, 409);
  const c = await ctx.balance("CLOTHES");
  assert.deepEqual([c.revenue, c.grossProfit, c.availablePurchaseFunds, c.distributableProfit], [0, 0, 0, 0]);
  assert.equal((await Product.findById(clothes._id)).stock, 1000);
});

itest("12. refunded and corrected statuses never contribute; recognized sales cannot be deleted", async () => {
  const clothes = await ctx.product("CLOTHES", 60, 100);
  const sale = (await ctx.sell([{ product: clothes, quantity: 1 }])).body;
  const base = await Sale.findById(sale._id).lean();
  for (const status of ["refunded", "corrected", "voided", "pending"]) {
    await Sale.collection.insertOne({ ...base, _id: new mongoose.Types.ObjectId(), saleId: `X-${status}`, saleNumber: `X-${status}`, status });
  }
  assert.equal((await ctx.balance("CLOTHES")).revenue, 100, "only the completed sale counts");
  const deletion = await ctx.request("DELETE", `/sales/${sale._id}`, { token: ctx.token("superadmin") });
  assert.equal(deletion.status, 409);
  assert.ok(await Sale.findById(sale._id), "history preserved");
});

itest("13. a corrected sale uses corrected values once and keeps its historical unit cost", async () => {
  const clothes = await ctx.product("CLOTHES", 60, 100);
  const sale = (await ctx.sell([{ product: clothes, quantity: 5 }])).body;
  await Product.updateOne({ _id: clothes._id }, { $set: { unitCost: 80 } });
  const edit = await ctx.request("PUT", `/sales/${sale._id}`, {
    token: ctx.token("staff"),
    body: { isWalkIn: true, items: [{ productId: String(clothes._id), quantity: 3, price: 110 }], paymentMethod: "cash", reason: "wrong quantity" },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const c = await ctx.balance("CLOTHES");
  assertIdentities(c);
  assert.deepEqual([c.revenue, c.costOfGoodsSold, c.grossProfit], [330, 180, 150]);
  assert.equal((await Product.findById(clothes._id)).stock, 997);
  const stored = await Sale.findById(sale._id).lean();
  const financials = stored.editHistory.at(-1).changes.financials;
  assert.equal(financials.from.totalRevenue, 500);
  assert.equal(financials.to.totalRevenue, 330);
  assert.equal(financials.from.items[0].costOfGoodsSold, 300, "previous snapshot preserved in the audit trail");

  const convert = await ctx.request("PUT", `/sales/${sale._id}`, {
    token: ctx.token("superadmin"),
    body: { type: "expense", reason: "x", recipientName: "x", recipientPhone: "1", amount: 1 },
  });
  assert.equal(convert.status, 400, "a sale can never be converted into an expense");
});

// ------------------------------------------------------------- expenses ----

itest("14-15. validated company expenses reduce each category's result; pending ones do not", async () => {
  const clothes = await ctx.product("CLOTHES", 60, 100);
  const shoes = await ctx.product("SHOES", 60, 100);
  await ctx.sell([{ product: clothes, quantity: 10 }, { product: shoes, quantity: 10 }]);
  const clothesExpense = await ctx.expense({ role: "manager", expenseType: "COMPANY_EXPENSE", category: "CLOTHES", amount: 100 });
  const shoesExpense = await ctx.expense({ role: "cashier_supervisor", expenseType: "COMPANY_EXPENSE", category: "SHOES", amount: 200 });
  assert.equal(clothesExpense.body.status, "pending");
  assert.equal((await ctx.balance("CLOTHES")).netProfit, 400, "pending does not reserve or deduct");

  assert.equal((await ctx.validate(clothesExpense.body._id)).status, 200);
  assert.equal((await ctx.validate(shoesExpense.body._id)).status, 200);
  const c = await ctx.balance("CLOTHES");
  assert.deepEqual([c.netProfit, c.distributableProfit, c.availablePurchaseFunds], [300, 300, 900]);
  const s = await ctx.balance("SHOES");
  assert.deepEqual([s.netProfit, s.shareholder1, s.shareholder2, s.availablePurchaseFunds], [200, 100, 100, 600]);
});

itest("16-17. expenses above gross profit produce a visible loss and zero distribution", async () => {
  const clothes = await ctx.product("CLOTHES", 60, 90);
  const shoes = await ctx.product("SHOES", 60, 90);
  await ctx.sell([{ product: clothes, quantity: 10 }, { product: shoes, quantity: 10 }]);
  await ctx.expense({ expenseType: "COMPANY_EXPENSE", category: "CLOTHES", amount: 500 });
  await ctx.expense({ expenseType: "COMPANY_EXPENSE", category: "SHOES", amount: 500 });
  const data = await summary({ date: TODAY });
  for (const key of ["CLOTHES", "SHOES"]) {
    const row = data.categoryBreakdown[key];
    assertIdentities(row);
    assert.equal(row.grossProfit, 300);
    assert.equal(row.netProfit, -200, `${key} loss is reported`);
    assert.equal(row.distributableProfit, 0);
    assert.equal(row.shareholder1, 0);
    assert.equal(row.shareholder2, 0);
    assert.equal(row.balance.availablePurchaseFunds, 400, `${key} loss was paid out of capital`);
  }
});

itest("18-20, 23. CLOTHES purchases use capital first, then profit, and stop at the limit", async () => {
  const clothes = await ctx.product("CLOTHES", 60, 100);
  await ctx.sell([{ product: clothes, quantity: 10 }]);
  await ctx.expense({ expenseType: "COMPANY_EXPENSE", category: "CLOTHES", amount: 100 });

  const first = await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "CLOTHES", amount: 500 });
  assert.equal(first.status, 201);
  assert.equal(first.body.fundingSource, "RECOVERED_CAPITAL");
  let c = await ctx.balance("CLOTHES");
  assert.deepEqual([c.remainingRecoveredCapital, c.distributableProfit], [100, 300]);

  const second = await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "CLOTHES", amount: 200 });
  assert.equal(second.body.fundingSource, "MIXED");
  assert.deepEqual([second.body.financialSnapshot.capitalUsed, second.body.financialSnapshot.profitUsed], [100, 100]);
  c = await ctx.balance("CLOTHES");
  assertIdentities(c);
  assert.deepEqual([c.profitUsedForPurchases, c.distributableProfit, c.availablePurchaseFunds], [100, 200, 200]);

  const tooMuch = await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "CLOTHES", amount: 200.01 });
  assert.equal(tooMuch.status, 409);
  assert.deepEqual([tooMuch.body.error, tooMuch.body.requested, tooMuch.body.available], ["INSUFFICIENT_PURCHASE_FUNDS", 200.01, 200]);
  assert.equal(await Expense.countDocuments({ expenseType: "GOODS_PURCHASE" }), 2, "refused purchase is not stored");
});

itest("21-22. SHOES purchases use recovered capital only; profit can never fund them", async () => {
  const shoes = await ctx.product("SHOES", 6000, 10000);
  await ctx.sell([{ product: shoes, quantity: 1 }]);
  assert.equal((await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 5500 })).status, 201);
  const refused = await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 700 });
  assert.equal(refused.status, 409);
  assert.deepEqual([refused.body.error, refused.body.requested, refused.body.available], ["INSUFFICIENT_PURCHASE_FUNDS", 700, 500]);
  const exact = await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 500 });
  assert.equal(exact.status, 201);
  assert.equal(exact.body.financialSnapshot.profitUsed, 0);
  const s = await ctx.balance("SHOES");
  assert.deepEqual([s.availablePurchaseFunds, s.profitUsedForPurchases, s.distributableProfit, s.shareholder1, s.shareholder2], [0, 0, 4000, 2000, 2000]);
});

itest("25. a rejected purchase never touches funds and can no longer be validated", async () => {
  const shoes = await ctx.product("SHOES", 60, 100);
  await ctx.sell([{ product: shoes, quantity: 10 }]);
  const purchase = await ctx.expense({ role: "inventory_manager", expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 300 });
  assert.equal(purchase.body.status, "pending");
  const reject = await ctx.request("PATCH", `/expenses/${purchase.body._id}/reject`, { token: ctx.token("manager"), body: { reason: "doublon" } });
  assert.equal(reject.status, 200);
  assert.equal((await ctx.validate(purchase.body._id)).status, 400);
  assert.equal((await ctx.balance("SHOES")).availablePurchaseFunds, 600);
});

itest("12, 26. validated purchases and expenses are reversed by auditable counter-entries", async () => {
  const shoes = await ctx.product("SHOES", 100, 150);
  const clothes = await ctx.product("CLOTHES", 0, 100);
  await ctx.sell([{ product: shoes, quantity: 10 }, { product: clothes, quantity: 10 }]);
  const purchase = await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 600 });
  assert.equal((await ctx.balance("SHOES")).availablePurchaseFunds, 400);

  const edit = await ctx.request("PUT", `/expenses/${purchase.body._id}`, { token: ctx.token("superadmin"), body: { reason: "x", recipientName: "x", recipientPhone: "1", amount: 1, updateReason: "x" } });
  assert.equal(edit.status, 409, "validated accounting records are immutable");
  assert.equal((await ctx.request("DELETE", `/expenses/${purchase.body._id}/admin`, { token: ctx.token("superadmin") })).status, 409);

  assert.equal((await ctx.request("POST", `/expenses/${purchase.body._id}/reverse`, { token: ctx.token("manager"), body: { reason: "erreur" } })).status, 403);
  const reversal = await ctx.request("POST", `/expenses/${purchase.body._id}/reverse`, { token: ctx.token("superadmin"), body: { reason: "erreur fournisseur" } });
  assert.equal(reversal.status, 201);
  assert.equal(reversal.body.transactionKind, "REVERSAL");
  assert.equal((await ctx.balance("SHOES")).availablePurchaseFunds, 1000);
  const original = await Expense.findById(purchase.body._id).lean();
  assert.equal(original.status, "validated");
  assert.equal(String(original.reversedBy), reversal.body._id);
  assert.equal((await ctx.request("POST", `/expenses/${purchase.body._id}/reverse`, { token: ctx.token("superadmin"), body: { reason: "again" } })).status, 409);
  assert.equal((await ctx.request("POST", `/expenses/${reversal.body._id}/reverse`, { token: ctx.token("superadmin"), body: { reason: "again" } })).status, 409);

  const expense = await ctx.expense({ expenseType: "COMPANY_EXPENSE", category: "CLOTHES", amount: 200 });
  assert.equal((await ctx.balance("CLOTHES")).netProfit, 800);
  await ctx.request("POST", `/expenses/${expense.body._id}/reverse`, { token: ctx.token("superadmin"), body: { reason: "annulée" } });
  assert.equal((await ctx.balance("CLOTHES")).netProfit, 1000);
  assert.equal(await Expense.countDocuments(), 4, "originals and reversals are all preserved");
});

itest("28-29. FC transactions keep their historical snapshot when today's rate changes", async () => {
  const shoes = await ctx.product("SHOES", 60, 100);
  const fcSale = await ctx.sell([{ product: shoes, quantity: 2, enteredCurrency: "FC", enteredPrice: 285000 }], { exchangeRate: 2850 });
  assert.equal(fcSale.status, 201, JSON.stringify(fcSale.body));
  const purchase = await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 10000, enteredCurrency: "FC", exchangeRate: 2850 });
  assert.equal(purchase.status, 201, JSON.stringify(purchase.body));
  const before = await ctx.balance("SHOES");
  assertIdentities(before);
  assert.equal(before.revenue, 200);
  assert.equal(before.revenueFC, 570000);
  assert.equal(before.goodsPurchases, 3.51, "10,000 FC / 2,850 rounded once to the cent");
  assert.equal(purchase.body.financialSnapshot.capitalUsed, 3.51);

  await ExchangeRate.create({ rate: 3500, createdBy: ctx.users.superadmin.user._id, isActive: true, effectiveFrom: new Date() });
  const after = await ctx.balance("SHOES");
  assert.deepEqual(after, { ...before, range: null }, "a new current rate changes nothing historical");
  const stored = await Expense.findById(purchase.body._id).lean();
  assert.deepEqual([stored.enteredAmount, stored.enteredCurrency, stored.amountFC, stored.exchangeRate], [10000, "FC", 10000, 2850]);
  assert.equal(stored.amountUSD, 10000 / 2850);
});

itest("30-32. mixed sales split per line; categories and shareholders stay isolated", async () => {
  const clothes = await ctx.product("CLOTHES", 6000, 10000);
  const shoes = await ctx.product("SHOES", 100, 150);
  const mixed = await ctx.sell([{ product: clothes, quantity: 1 }, { product: shoes, quantity: 1 }]);
  assert.equal((await ctx.balance("CLOTHES")).availablePurchaseFunds, 10000);
  assert.equal((await ctx.balance("SHOES")).availablePurchaseFunds, 100);

  const attack = await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 500 });
  assert.equal(attack.status, 409, "CLOTHES money never finances SHOES");
  assert.equal(attack.body.available, 100);
  assert.equal((await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "BOTH", amount: 1 })).status, 400);
  assert.equal((await ctx.expense({ expenseType: "GOODS_PURCHASE", amount: 1 })).status, 400);

  const shoeView = await summary({ category: "CLOTHES", date: TODAY }, "shoesShareholder");
  assert.equal(shoeView.assignedCategory, "SHOES");
  assert.deepEqual(Object.keys(shoeView.categoryBreakdown), ["SHOES"]);
  assert.equal(shoeView.categoryBreakdown.SHOES.revenue, 150);
  const clothesView = await summary({ date: TODAY }, "clothesShareholder");
  assert.deepEqual(Object.keys(clothesView.categoryBreakdown), ["CLOTHES"]);
  assert.equal(clothesView.shareholderEntitlement, 4000);

  const shareholder = ctx.token("shoesShareholder");
  assert.equal((await ctx.request("GET", "/expenses/funds/CLOTHES", { token: shareholder })).status, 403);
  assert.equal((await ctx.request("POST", "/expenses", { token: shareholder, body: {} })).status, 403);
  assert.equal((await ctx.request("PATCH", `/sales/${mixed.body._id}/void`, { token: shareholder, body: {} })).status, 403);
  assert.equal((await ctx.request("GET", "/analytics/summary", { token: ctx.token("manager") })).status, 403);

  const staffFunds = await ctx.request("GET", "/expenses/funds/SHOES", { token: ctx.token("cashier_supervisor") });
  assert.equal(staffFunds.status, 200);
  assert.deepEqual(Object.keys(staffFunds.body).sort(), ["availablePurchaseFunds", "basis", "category", "fundingShortfall"]);
  assert.equal((await ctx.request("GET", "/expenses/funds/SHOES", { token: ctx.token("staff") })).status, 403);

  await ctx.request("PATCH", `/sales/${mixed.body._id}/void`, { token: ctx.token("superadmin"), body: {} });
  assert.equal((await ctx.balance("CLOTHES")).revenue, 0);
  assert.equal((await ctx.balance("SHOES")).revenue, 0);
});

itest("33. legacy cash-outs stay in cash history but never touch category accounting", async () => {
  const shoes = await ctx.product("SHOES", 60, 100);
  await ctx.sell([{ product: shoes, quantity: 10 }]);
  const legacy = await Expense.create({
    expenseId: "LEG-1", reason: "ancienne sortie", recipientName: "x", recipientPhone: "1", amount: 50, amountUSD: 50,
    recordedBy: "legacy", status: "validated", validatedAt: new Date(), expenseType: "LEGACY_UNCLASSIFIED",
  });
  const pendingLegacy = await Expense.create({
    expenseId: "LEG-2", reason: "ancienne sortie", recipientName: "x", recipientPhone: "1", amount: 20,
    recordedBy: "legacy", status: "pending", expenseType: "LEGACY_UNCLASSIFIED",
  });
  const s = await ctx.balance("SHOES");
  assert.deepEqual([s.companyExpenses, s.netProfit, s.availablePurchaseFunds], [0, 400, 600]);
  const data = await summary({ date: TODAY });
  assert.equal(data.totalValidatedExpenses, 50, "still part of global cash reporting");
  assert.equal(data.totalCompanyExpenses, 0);
  assert.equal((await ctx.validate(pendingLegacy._id)).status, 409, "legacy records are never auto-classified");
  assert.equal((await ctx.request("DELETE", `/expenses/${legacy._id}/admin`, { token: ctx.token("superadmin") })).status, 409);
  const reprice = await ctx.request("PUT", `/expenses/${legacy._id}`, { token: ctx.token("superadmin"), body: { reason: "x", recipientName: "x", recipientPhone: "1", amount: 10, updateReason: "fix" } });
  assert.equal(reprice.status, 409);
  const stored = await Expense.findById(legacy._id).lean();
  assert.equal(stored.category, undefined);
  assert.equal(stored.amount, 50);
});

// ------------------------------------------------------------ reporting ----

itest("34-35. period performance is separate from the cumulative available balance", async () => {
  const shoes = await ctx.product("SHOES", 60, 100);
  const old = await ctx.sell([{ product: shoes, quantity: 10 }]);
  await ctx.backdate(Sale, old.body._id, atPastNoon);
  const oldPurchase = await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 200 });
  await ctx.backdate(Expense, oldPurchase.body._id, atPastNoon, { validatedAt: atPastNoon });
  await ctx.sell([{ product: shoes, quantity: 5 }]);

  const today = (await summary({ date: TODAY })).categoryBreakdown.SHOES;
  assert.deepEqual([today.revenue, today.costOfGoodsSold, today.goodsPurchases], [500, 300, 0]);
  assert.equal(today.balance.availablePurchaseFunds, 700, "capital recovered earlier stays available");
  assert.equal(today.availablePurchaseFunds, 700);
  assert.equal(today.distributableProfit, 200, "period share");
  assert.equal(today.balance.distributableProfit, 600, "cumulative share");

  const past = (await summary({ date: PAST })).categoryBreakdown.SHOES;
  assert.deepEqual([past.revenue, past.goodsPurchases], [1000, 200]);
  assert.equal(past.balance.availablePurchaseFunds, 700, "the balance is always as of now");
});

itest("36-38. Analytics DTO reconciles exactly with the service; odd cents and large amounts are exact", async () => {
  const shoes = await ctx.product("SHOES", 0.01, 0.06);
  const clothes = await ctx.product("CLOTHES", 599999.99, 999999.99);
  await ctx.sell([{ product: shoes, quantity: 1 }, { product: clothes, quantity: 2 }]);
  const data = await summary({ date: TODAY });
  for (const category of ["CLOTHES", "SHOES"]) {
    const period = await aggregateCategoryAccounting(category, { range: todayRange });
    const balance = await aggregateCategoryAccounting(category);
    const row = data.categoryBreakdown[category];
    for (const field of ["revenue", "costOfGoodsSold", "grossProfit", "companyExpenses", "netProfit", "goodsPurchases", "recoveredCapital", "profitUsedForPurchases", "distributableProfit", "shareholder1", "shareholder2"]) {
      assert.equal(row[field], period[field], `${category}.${field}`);
    }
    for (const field of ["availablePurchaseFunds", "remainingRecoveredCapital", "fundingShortfall", "distributableProfit", "shareholder1", "shareholder2"]) {
      assert.equal(row.balance[field], balance[field], `${category}.balance.${field}`);
    }
  }
  const s = data.categoryBreakdown.SHOES;
  assert.deepEqual([s.distributableProfit, s.shareholder1, s.shareholder2], [0.05, 0.03, 0.02]);
  const c = data.categoryBreakdown.CLOTHES;
  assert.deepEqual([c.revenue, c.costOfGoodsSold, c.grossProfit], [1999999.98, 1199999.98, 800000]);
  assert.equal(data.costOfGoodsSold, 1199999.99);
  assert.equal(data.grossProfit, 800000.05);
});

itest("32. final reconciliation: realistic multi-product scenario across both categories", async () => {
  const dress = await ctx.product("CLOTHES", 25, 40);
  const shirt = await ctx.product("CLOTHES", 10.5, 19.99);
  const heels = await ctx.product("SHOES", 45, 80);
  const sneakers = await ctx.product("SHOES", 32.25, 55);

  await ctx.sell([{ product: dress, quantity: 12 }, { product: heels, quantity: 3 }]);
  await ctx.sell([{ product: shirt, quantity: 30 }], { paymentMethod: "card" });
  await ctx.sell([{ product: sneakers, quantity: 7 }, { product: shirt, quantity: 2 }], { paymentMethod: "transfer" });
  await ctx.sell([{ product: dress, quantity: 3, enteredCurrency: "FC", enteredPrice: 114000 }], { exchangeRate: 2850 });
  const voided = await ctx.sell([{ product: heels, quantity: 1 }]);
  await ctx.request("PATCH", `/sales/${voided.body._id}/void`, { token: ctx.token("superadmin"), body: {} });
  const pendingReservation = await ctx.sell([{ product: sneakers, quantity: 2 }], { type: "reservation" });
  assert.equal(pendingReservation.body.status, "pending");

  // CLOTHES: revenue 12*40 + 32*19.99 + 3*40 = 1239.68; COGS 300 + 336 + 75 = 711.
  await ctx.expense({ expenseType: "COMPANY_EXPENSE", category: "CLOTHES", amount: 120.5 });
  const clothesCapitalPurchase = await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "CLOTHES", amount: 500 });
  const clothesMixedPurchase = await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "CLOTHES", amount: 713160, enteredCurrency: "FC", exchangeRate: 2850 });
  assert.equal(clothesCapitalPurchase.body.fundingSource, "RECOVERED_CAPITAL");
  assert.equal(clothesMixedPurchase.body.fundingSource, "MIXED");
  assert.deepEqual([clothesMixedPurchase.body.financialSnapshot.capitalUsed, clothesMixedPurchase.body.financialSnapshot.profitUsed], [211, 39.23]);

  // SHOES: revenue 3*80 + 7*55 = 625; COGS 135 + 225.75 = 360.75.
  await ctx.expense({ expenseType: "COMPANY_EXPENSE", category: "SHOES", amount: 50.01 });
  await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 300 });
  const overPurchase = await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 61 });
  assert.equal(overPurchase.status, 409);
  assert.equal(overPurchase.body.available, 60.75);

  const data = await summary({ date: TODAY });
  const c = data.categoryBreakdown.CLOTHES;
  assertIdentities(c);
  assert.deepEqual([c.revenue, c.costOfGoodsSold, c.grossProfit, c.companyExpenses, c.netProfit], [1239.68, 711, 528.68, 120.5, 408.18]);
  assert.deepEqual([c.goodsPurchases, c.capitalUsedForPurchases, c.profitUsedForPurchases], [750.23, 711, 39.23]);
  assert.equal(cents(c.recoveredCapital) + cents(c.netProfit) - cents(c.goodsPurchases), cents(c.balance.availablePurchaseFunds));
  assert.equal(cents(c.netProfit) - cents(c.profitUsedForPurchases), cents(c.distributableProfit));
  assert.deepEqual([c.balance.availablePurchaseFunds, c.distributableProfit, c.shareholder1], [368.95, 368.95, 368.95]);

  const s = data.categoryBreakdown.SHOES;
  assertIdentities(s);
  assert.deepEqual([s.revenue, s.costOfGoodsSold, s.grossProfit, s.companyExpenses, s.netProfit], [625, 360.75, 264.25, 50.01, 214.24]);
  assert.equal(cents(s.recoveredCapital) - cents(s.goodsPurchases), cents(s.balance.availablePurchaseFunds));
  assert.equal(s.balance.availablePurchaseFunds, 60.75);
  assert.equal(s.profitUsedForPurchases, 0);
  assert.equal(cents(s.shareholder1) + cents(s.shareholder2), cents(s.netProfit));
  assert.deepEqual([s.shareholder1, s.shareholder2], [107.12, 107.12]);

  assert.equal(data.realizedRevenue, 1864.68);
  assert.equal(data.pendingReservationAmount, 110, "reservation deposits are cash, not revenue");
  assert.equal(cents(data.totalRevenue), cents(1864.68) + cents(110));
});

// ------------------------------------------------------ today-only rule ----

itest("27b. non-admin roles cannot reach previous days through the API", async () => {
  const shoes = await ctx.product("SHOES", 60, 100);
  const old = await ctx.sell([{ product: shoes, quantity: 1 }]);
  await ctx.backdate(Sale, old.body._id, atPastNoon);
  await ctx.sell([{ product: shoes, quantity: 1 }]);
  const oldExpense = await ctx.expense({ expenseType: "COMPANY_EXPENSE", category: "SHOES", amount: 1 });
  await ctx.backdate(Expense, oldExpense.body._id, atPastNoon, { validatedAt: atPastNoon });

  for (const role of ["manager", "inventory_manager", "cashier_supervisor", "staff"]) {
    const token = ctx.token(role);
    const list = await ctx.request("GET", `/sales?date=${PAST}`, { token });
    assert.equal(list.status, 200);
    assert.ok(list.body.data.every((sale) => sale._id !== old.body._id), `${role} list`);
    assert.equal(list.body.data.length, 1, `${role} sees today only`);
    assert.equal((await ctx.request("GET", `/sales/${old.body._id}`, { token })).status, 404);
    const put = await ctx.request("PUT", `/sales/${old.body._id}`, { token, body: { isWalkIn: true, items: [{ productId: String(shoes._id), quantity: 1, price: 1 }] } });
    assert.equal(put.status, 404, `${role} cannot correct an old sale`);
    const daily = await ctx.request("GET", `/sales/stats/daily?date=${PAST}`, { token });
    assert.equal(daily.body.date, TODAY);
    assert.equal(daily.body.totalSales, 1);
    const entriesDaily = await ctx.request("GET", `/entries/stats/daily?date=${PAST}`, { token });
    if (entriesDaily.status === 200) assert.equal(entriesDaily.body.date, TODAY, `${role} entries daily`);
    const reservations = await ctx.request("GET", `/sales/reservations/all?from=${PAST}&to=${PAST}`, { token });
    assert.ok((reservations.body.data || []).every((sale) => sale._id !== old.body._id));
    if (role !== "staff") {
      const expenses = await ctx.request("GET", `/expenses?from=${PAST}&to=${PAST}`, { token });
      assert.equal(expenses.status, 200);
      assert.ok(expenses.body.data.every((expense) => expense._id !== oldExpense.body._id), `${role} expenses`);
      assert.equal((await ctx.request("GET", `/expenses/${oldExpense.body._id}`, { token })).status, 404);
    } else {
      assert.equal((await ctx.request("GET", "/expenses", { token })).status, 403);
    }
  }
  const admin = await ctx.request("GET", `/sales?date=${PAST}`, { token: ctx.token("superadmin") });
  assert.ok(admin.body.data.some((sale) => sale._id === old.body._id));
});
