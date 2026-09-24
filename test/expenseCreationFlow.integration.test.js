// POST /api/expenses end to end: auth chain -> validation -> transaction ->
// unique indexes -> HTTP status. Each failure class must keep its own status
// and message so the confirmation dialog never shows a misleading error.
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { SKIP, createIntegrationContext } = require("./helpers/integrationContext");
const Expense = require("../models/Expense");
const { repairReversalIndex } = require("../scripts/migrateExpenseAccounting");

const ctx = createIntegrationContext();
test.before(ctx.setup);
test.after(ctx.teardown);
test.beforeEach(ctx.reset);
const itest = (name, fn) => test(name, { skip: SKIP }, fn);

const companyExpense = (reason, extra = {}) => ({ role: "manager", expenseType: "COMPANY_EXPENSE", category: "CLOTHES", amount: 5, reason, ...extra });

// Reproduces the production collection: the obsolete unique+sparse index still
// sits next to its replacement, and one legacy record stores reversalOf: null.
async function installObsoleteReversalIndex() {
  await Expense.collection.createIndex({ reversalOf: 1 }, { unique: true, sparse: true, name: "reversalOf_1" });
  await Expense.collection.insertOne({
    expenseId: "LEGACY-1", reason: "r", recipientName: "n", recipientPhone: "1", amount: 1,
    recordedBy: "x", status: "validated", expenseType: "LEGACY_UNCLASSIFIED", reversalOf: null, createdAt: new Date(),
  });
}

async function dropObsoleteReversalIndex() {
  const names = (await Expense.collection.indexes()).map((index) => index.name);
  if (names.includes("reversalOf_1")) await Expense.collection.dropIndex("reversalOf_1");
}

itest("obsolete reversalOf_1 index is reported as a server fault, never as a duplicate expense", async () => {
  await installObsoleteReversalIndex();
  try {
    const response = await ctx.expense(companyExpense("Loyer"));
    assert.notEqual(response.body?.error, "Expense ID already exists");
    assert.equal(response.status, 500, JSON.stringify(response.body));
    assert.equal(response.body.error, "EXPENSE_INDEX_MISCONFIGURED");
    assert.equal(await Expense.countDocuments({ reason: "Loyer" }), 0);
  } finally {
    await dropObsoleteReversalIndex();
  }
});

itest("index repair drops reversalOf_1 and keeps the partial replacement", async () => {
  await installObsoleteReversalIndex();
  const result = await repairReversalIndex();
  assert.equal(result.droppedBrokenReversalIndex, true);
  const names = (await Expense.collection.indexes()).map((index) => index.name);
  assert.ok(!names.includes("reversalOf_1"));
  assert.ok(names.includes("reversalOf_unique_when_set"));
  assert.equal((await repairReversalIndex()).droppedBrokenReversalIndex, false, "idempotent");
});

itest("three consecutive normal expenses are each inserted once with reversalOf null", async () => {
  const requests = [
    companyExpense("Loyer", { amount: 5, requestKey: "key-0" }),
    companyExpense("Électricité", { amount: 23100, enteredCurrency: "FC", exchangeRate: 2310, requestKey: "key-1" }),
    companyExpense("Transport", { amount: 7, requestKey: "key-2" }),
  ];
  const created = [];
  for (const request of requests) {
    const response = await ctx.expense(request);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.reversalOf, null);
    assert.equal(String(response.body.requestedBy), String(ctx.users.manager.user._id), "req.user resolved from the Bearer token");
    assert.ok(response.body.createdAt);
    assert.ok(response.body.updatedAt);
    created.push(response.body);
  }

  assert.equal(new Set(created.map((expense) => expense.expenseId)).size, 3, "expense IDs are unique");
  assert.deepEqual(created.map((expense) => expense.requestKey), requests.map((request) => request.requestKey));
  assert.deepEqual(
    [created[1].enteredAmount, created[1].enteredCurrency, created[1].amountUSD, created[1].amountFC, created[1].exchangeRate],
    [23100, "FC", 10, 23100, 2310],
    "the server preserves the entered FC amount and computes USD with FC = USD × rate"
  );
  for (const { reason } of requests) assert.equal(await Expense.countDocuments({ reason }), 1);

  const history = await ctx.request("GET", "/expenses?limit=50", { token: ctx.token("manager") });
  assert.equal(history.status, 200, JSON.stringify(history.body));
  const historyIds = new Set(history.body.data.map((expense) => expense._id));
  for (const expense of created) assert.ok(historyIds.has(expense._id), `${expense.expenseId} is visible in Sortie history`);
});

itest("a repeated submission replays the original record instead of inserting twice", async () => {
  const first = await ctx.expense(companyExpense("Loyer", { requestKey: "same-click" }));
  const second = await ctx.expense(companyExpense("Loyer", { requestKey: "same-click" }));
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body._id, first.body._id);
  assert.equal(await Expense.countDocuments({ requestKey: "same-click" }), 1);
});

itest("missing, malformed and expired tokens are 401 'Authentication required', never 400", async () => {
  const body = { expenseType: "COMPANY_EXPENSE", category: "CLOTHES", reason: "x", recipientName: "n", recipientPhone: "1", amount: 1 };
  const expired = jwt.sign({ id: String(ctx.users.manager.user._id), exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
  for (const token of [undefined, "not-a-jwt", expired]) {
    const response = await ctx.request("POST", "/expenses", { token, body });
    assert.equal(response.status, 401, JSON.stringify(response.body));
    assert.deepEqual(response.body, { message: "Authentication required" });
  }
  assert.equal(await Expense.countDocuments({}), 0);
});

itest("an authenticated role without expense access gets 403", async () => {
  const response = await ctx.expense(companyExpense("x", { role: "staff" }));
  assert.equal(response.status, 403);
});

itest("an invalid payload is a 400 validation error", async () => {
  const response = await ctx.expense(companyExpense("x", { amount: 0 }));
  assert.equal(response.status, 400);
  assert.match(response.body.error, /required/);
});

itest("a real expenseId collision is a 409 conflict with its own code", async () => {
  const realNow = Date.now;
  const realRandom = Math.random;
  Date.now = () => 1_700_000_000_000;
  Math.random = () => 0.123456789;
  try {
    assert.equal((await ctx.expense(companyExpense("A"))).status, 201);
    const clash = await ctx.expense(companyExpense("B"));
    assert.equal(clash.status, 409, JSON.stringify(clash.body));
    assert.equal(clash.body.error, "DUPLICATE_EXPENSE_ID");
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }
  assert.equal(await Expense.countDocuments({ reason: "B" }), 0);
});

itest("reusing a request key with different data is a 409 idempotency conflict", async () => {
  assert.equal((await ctx.expense(companyExpense("A", { requestKey: "k" }))).status, 201);
  const changed = await ctx.expense(companyExpense("A", { requestKey: "k", amount: 9 }));
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "IDEMPOTENCY_CONFLICT");
});
