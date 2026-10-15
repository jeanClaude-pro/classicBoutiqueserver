// Every money movement is recorded exactly once and leaves an audit trail,
// even when the connection drops and the till retries.
const test = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, createIntegrationContext } = require("./helpers/integrationContext");
const Sale = require("../models/Sale");
const Entry = require("../models/Entry");
const Expense = require("../models/Expense");
const Loan = require("../models/Loan");
const Creditor = require("../models/Creditor");
const AuditLog = require("../models/AuditLog");

const ctx = createIntegrationContext();
test.before(ctx.setup);
test.after(ctx.teardown);
test.beforeEach(ctx.reset);
const itest = (name, fn) => test(name, { skip: SKIP }, fn);

itest("every recorded sale has an audit record written with it", async () => {
  const product = await ctx.product("CLOTHES", 10, 20);
  const created = await ctx.sell([{ product, quantity: 2 }], { exchangeRate: 2800, requestKey: "audit-sale-1" });
  assert.equal(created.status, 201);
  const audit = await AuditLog.findOne({ action: "SALE_RECORDED", targetId: String(created.body._id) }).lean();
  assert.ok(audit, "SALE_RECORDED exists");
  assert.equal(audit.after.total, 40);
  assert.equal(audit.after.items[0].quantity, 2);
  assert.equal(audit.after.requestKey, "audit-sale-1");
  assert.ok(!JSON.stringify(audit).match(/unitAcquisitionCost|costOfGoodsSold|grossProfit/), "no cost or profit in the trail");
});

itest("a retried sale is recorded once and audited once", async () => {
  const product = await ctx.product("SHOES", 10, 20, 10);
  const first = await ctx.sell([{ product, quantity: 1 }], { exchangeRate: 2800, requestKey: "retry-sale-1" });
  const second = await ctx.sell([{ product, quantity: 1 }], { exchangeRate: 2800, requestKey: "retry-sale-1" });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(await Sale.countDocuments({ requestKey: "retry-sale-1" }), 1);
  assert.equal(await AuditLog.countDocuments({ action: "SALE_RECORDED", targetId: String(first.body._id) }), 1);
});

itest("a refused sale is kept in the audit log with the cart that was sent", async () => {
  const product = await ctx.product("CLOTHES", 10, 20, 1);
  const refused = await ctx.sell([{ product, quantity: 3 }], { exchangeRate: 2800, requestKey: "refused-sale-1" });
  assert.ok(refused.status >= 400);
  assert.equal(await Sale.countDocuments({}), 0);
  const audit = await AuditLog.findOne({ action: "SALE_REJECTED", "details.attempt.requestKey": "refused-sale-1" }).lean();
  assert.ok(audit, "the refusal is audited");
  assert.equal(audit.outcome, "failure");
  assert.equal(audit.details.attempt.items[0].quantity, 3);
});

itest("a retried cash entry is recorded once and audited", async () => {
  const body = { amount: 15, source: "Caisse", category: "Apport", description: "fonds", requestKey: "entry-retry-1" };
  const first = await ctx.request("POST", "/entries", { token: ctx.token("manager"), body });
  const second = await ctx.request("POST", "/entries", { token: ctx.token("manager"), body });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(String(second.body._id), String(first.body._id));
  assert.equal(await Entry.countDocuments({ requestKey: "entry-retry-1" }), 1);
  assert.ok(await AuditLog.exists({ action: "ENTRY_CREATED", targetId: String(first.body._id) }));
});

itest("a request key reused for a different entry is refused", async () => {
  const token = ctx.token("manager");
  const base = { source: "Caisse", category: "Apport", requestKey: "entry-reuse-1" };
  assert.equal((await ctx.request("POST", "/entries", { token, body: { ...base, amount: 15 } })).status, 201);
  assert.equal((await ctx.request("POST", "/entries", { token, body: { ...base, amount: 99 } })).status, 409);
  assert.equal(await Entry.countDocuments({ requestKey: "entry-reuse-1" }), 1);
});

itest("expense creation and validation are audited", async () => {
  const created = await ctx.expense({ role: "manager", expenseType: "COMPANY_EXPENSE", category: "CLOTHES", amount: 5, requestKey: "exp-audit-1" });
  assert.equal(created.status, 201);
  assert.ok(await AuditLog.exists({ action: "EXPENSE_CREATED", targetId: String(created.body._id) }));
  const validated = await ctx.validate(created.body._id);
  assert.equal(validated.status, 200);
  assert.ok(await AuditLog.exists({ action: "EXPENSE_VALIDATED", targetId: String(created.body._id) }));
  assert.equal(await Expense.countDocuments({ requestKey: "exp-audit-1" }), 1);
});

itest("a retried loan adds the debt once", async () => {
  const creditor = await Creditor.create({ name: `Prêteur-${Date.now()}`, type: "person", createdBy: ctx.users.superadmin.user._id });
  const body = { enteredAmount: 100, enteredCurrency: "USD", exchangeRate: 2800, amount: 100, requestKey: `loan-${creditor._id}` };
  const first = await ctx.request("POST", `/creditors/${creditor._id}/loans`, { token: ctx.token("superadmin"), body });
  const second = await ctx.request("POST", `/creditors/${creditor._id}/loans`, { token: ctx.token("superadmin"), body });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(await Loan.countDocuments({ creditorId: creditor._id }), 1);
  assert.equal((await Creditor.findById(creditor._id)).remainingBalance, 100);
  assert.ok(await AuditLog.exists({ action: "LOAN_RECORDED", targetId: String(creditor._id) }));
});

itest("only the Entry module may record money in", async () => {
  const historyOnly = await require("./helpers/testApp").createUser("manager", { permissions: ["/entryhistory"] });
  const response = await ctx.request("POST", "/entries", { token: historyOnly.token, body: { amount: 5, source: "Caisse", category: "Apport" } });
  assert.equal(response.status, 403);
});
