// Double-spending, idempotency and migration safety against a real MongoDB
// replica set. Requests run truly in parallel through the HTTP routes, so the
// AccountingLock, write conflicts and transaction retries are exercised.
const test = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, createIntegrationContext } = require("./helpers/integrationContext");
const Sale = require("../models/Sale");
const Expense = require("../models/Expense");
const { migrateExpenseAccounting } = require("../scripts/migrateExpenseAccounting");

const ctx = createIntegrationContext();
test.before(ctx.setup);
test.after(ctx.teardown);
test.beforeEach(ctx.reset);
const itest = (name, fn) => test(name, { skip: SKIP }, fn);

async function shoesCapital(amount) {
  const shoes = await ctx.product("SHOES", amount, amount * 2);
  await ctx.sell([{ product: shoes, quantity: 1 }]);
  return shoes;
}

async function pendingPurchase(amount, category = "SHOES") {
  const response = await ctx.expense({ role: "manager", expenseType: "GOODS_PURCHASE", category, amount });
  assert.equal(response.body.status, "pending");
  return response.body._id;
}

itest("24. two devices validating 700 + 700 against 1000: exactly one succeeds", async () => {
  for (let round = 0; round < 5; round += 1) {
    await ctx.reset();
    await shoesCapital(1000);
    const [a, b] = [await pendingPurchase(700), await pendingPurchase(700)];
    const results = await Promise.all([ctx.validate(a), ctx.validate(b, "superadmin")]);
    const statuses = results.map((result) => result.status).sort();
    assert.deepEqual(statuses, [200, 409], `round ${round}`);
    const refused = results.find((result) => result.status === 409).body;
    assert.deepEqual([refused.error, refused.requested, refused.available], ["INSUFFICIENT_PURCHASE_FUNDS", 700, 300]);
    const balance = await ctx.balance("SHOES");
    assert.equal(balance.availablePurchaseFunds, 300);
    assert.equal(await Expense.countDocuments({ status: "validated" }), 1);
  }
});

itest("24b. eight parallel validations never spend more than the balance", async () => {
  await shoesCapital(1000);
  const ids = [];
  for (let i = 0; i < 8; i += 1) ids.push(await pendingPurchase(150));
  const results = await Promise.all(ids.map((id, index) => ctx.validate(id, index % 2 ? "manager" : "superadmin")));
  assert.equal(results.filter((result) => result.status === 200).length, 6);
  assert.equal(results.filter((result) => result.status === 409).length, 2);
  const balance = await ctx.balance("SHOES");
  assert.equal(balance.goodsPurchases, 900);
  assert.equal(balance.availablePurchaseFunds, 100);
  const snapshots = (await Expense.find({ status: "validated" }).sort({ validatedAt: 1 }).lean()).map((expense) => expense.financialSnapshot);
  // Serialized: each validation saw the previous one's result.
  assert.deepEqual(snapshots.map((snapshot) => snapshot.availableBefore).sort((x, y) => y - x), [1000, 850, 700, 550, 400, 250]);
});

itest("24c. parallel auto-validated creations cannot double-spend either", async () => {
  await shoesCapital(1000);
  const results = await Promise.all([1, 2, 3].map(() => ctx.expense({ expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 400 })));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 201, 409]);
  assert.equal((await ctx.balance("SHOES")).availablePurchaseFunds, 200);
});

itest("24d. a sale void racing a purchase validation is serialized by the lock", async () => {
  for (let round = 0; round < 4; round += 1) {
    await ctx.reset();
    const shoes = await ctx.product("SHOES", 600, 1000);
    const cheap = await ctx.product("SHOES", 400, 700);
    const big = await ctx.sell([{ product: shoes, quantity: 1 }]);
    await ctx.sell([{ product: cheap, quantity: 1 }]);
    const purchase = await pendingPurchase(700);
    const [voided, validated] = await Promise.all([
      ctx.request("PATCH", `/sales/${big.body._id}/void`, { token: ctx.token("superadmin"), body: {} }),
      ctx.validate(purchase),
    ]);
    assert.equal(voided.status, 200);
    const balance = await ctx.balance("SHOES");
    if (validated.status === 200) {
      assert.equal(validated.body.financialSnapshot.availableBefore, 1000, "validated before the void");
      assert.equal(balance.fundingShortfall, 300, "the void after spending is exposed, not hidden");
    } else {
      assert.equal(validated.status, 409);
      assert.equal(validated.body.available, 400, "validated after the void");
      assert.equal(balance.availablePurchaseFunds, 400);
    }
  }
});

itest("25b. reject racing validate never leaves a rejected record that consumed funds", async () => {
  for (let round = 0; round < 6; round += 1) {
    await ctx.reset();
    await shoesCapital(1000);
    const id = await pendingPurchase(600);
    await Promise.all([
      ctx.validate(id),
      ctx.request("PATCH", `/expenses/${id}/reject`, { token: ctx.token("superadmin"), body: { reason: "race" } }),
    ]);
    const stored = await Expense.findById(id).lean();
    const balance = await ctx.balance("SHOES");
    if (stored.status === "validated") {
      assert.equal(stored.financialSnapshot.capitalUsed, 600);
      assert.equal(balance.availablePurchaseFunds, 400);
    } else {
      assert.equal(stored.status, "rejected");
      assert.equal(stored.financialSnapshot?.capitalUsed, undefined);
      assert.equal(balance.availablePurchaseFunds, 1000);
    }
  }
});

itest("26b. concurrent reversal requests restore funds exactly once", async () => {
  await shoesCapital(1000);
  const purchase = await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 600 });
  const results = await Promise.all([1, 2, 3].map(() => ctx.request("POST", `/expenses/${purchase.body._id}/reverse`, { token: ctx.token("superadmin"), body: { reason: "double click" } })));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409, 409]);
  assert.equal(await Expense.countDocuments({ transactionKind: "REVERSAL" }), 1);
  assert.equal((await ctx.balance("SHOES")).availablePurchaseFunds, 1000);
});

itest("27. duplicate VALIDER clicks consume funds and deduct expenses once", async () => {
  const clothes = await ctx.product("CLOTHES", 60, 100);
  await ctx.sell([{ product: clothes, quantity: 10 }]);
  await shoesCapital(1000);
  const purchase = await pendingPurchase(700);
  const sequential = [await ctx.validate(purchase), await ctx.validate(purchase)];
  assert.deepEqual(sequential.map((result) => result.status), [200, 200]);
  assert.equal(sequential[0].body.validatedAt, sequential[1].body.validatedAt);

  const expense = (await ctx.expense({ role: "manager", expenseType: "COMPANY_EXPENSE", category: "CLOTHES", amount: 100 })).body._id;
  const parallel = await Promise.all([1, 2, 3, 4, 5].map(() => ctx.validate(expense)));
  assert.ok(parallel.every((result) => result.status === 200), JSON.stringify(parallel.map((result) => result.status)));
  assert.equal((await ctx.balance("SHOES")).availablePurchaseFunds, 300);
  assert.equal((await ctx.balance("CLOTHES")).companyExpenses, 100);
});

itest("27b. a replayed create request returns the original record", async () => {
  await shoesCapital(1000);
  const body = { expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 700, requestKey: "sortie-7f3a" };
  const first = await ctx.expense(body);
  const second = await ctx.expense(body);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body._id, first.body._id);

  const parallel = await Promise.all([1, 2, 3, 4].map(() => ctx.expense({ ...body, requestKey: "sortie-parallel", amount: 300 })));
  assert.ok(parallel.every((result) => [200, 201].includes(result.status)), JSON.stringify(parallel.map((result) => result.status)));
  assert.equal(new Set(parallel.map((result) => result.body._id)).size, 1);
  assert.equal(await Expense.countDocuments({ requestKey: "sortie-parallel" }), 1);
  assert.equal((await ctx.balance("SHOES")).availablePurchaseFunds, 0);

  const stolen = await ctx.expense({ ...body, role: "manager" });
  assert.equal(stolen.status, 409, "another user cannot replay someone else's key");
});

itest("27c. the same request key with different financial data is a conflict", async () => {
  await shoesCapital(1000);
  const key = "sortie-payload-conflict";
  const first = await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 100, requestKey: key });
  const changed = await ctx.expense({ expenseType: "GOODS_PURCHASE", category: "SHOES", amount: 500, requestKey: key });

  assert.equal(first.status, 201);
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "IDEMPOTENCY_CONFLICT");
  assert.match(changed.body.message, /données différentes/);
  assert.equal(await Expense.countDocuments({ requestKey: key }), 1);
  assert.equal((await Expense.findOne({ requestKey: key }).lean()).amountUSD, 100);
  assert.equal((await ctx.balance("SHOES")).availablePurchaseFunds, 900);
});

itest("index regression: many expenses can coexist with reversalOf = null", async () => {
  for (let i = 0; i < 3; i += 1) {
    const response = await ctx.expense({ role: "manager", expenseType: "COMPANY_EXPENSE", category: "SHOES", amount: 1 });
    assert.equal(response.status, 201, JSON.stringify(response.body));
  }
  assert.equal(await Expense.countDocuments({ reversalOf: null }), 3);
});

itest("31. migration is idempotent, repairs the broken index and never classifies legacy data", async () => {
  await Expense.collection.dropIndexes();
  await Expense.collection.createIndex({ reversalOf: 1 }, { unique: true, sparse: true, name: "reversalOf_1" });
  const raw = (overrides) => ({ reason: "r", recipientName: "n", recipientPhone: "1", amount: 10, recordedBy: "x", status: "validated", createdAt: new Date(), ...overrides });
  await Expense.collection.insertMany([
    raw({ expenseId: "L1", expenseType: "normal" }),
    raw({ expenseId: "L2" }),
    raw({ expenseId: "L3", expenseType: "repayment" }),
    raw({ expenseId: "L4", expenseType: "GOODS_PURCHASE", category: "SHOES", fundingSource: "REVENUE_CAPITAL" }),
  ]);

  const dryRun = await migrateExpenseAccounting({ dryRun: true });
  assert.deepEqual(dryRun.wouldMigrate, { repayments: 1, legacyUnclassified: 2, fundingTerminology: 1, unclassifiedAccountingRecords: 0 });
  assert.equal(await Expense.countDocuments({ expenseType: "normal" }), 1, "dry run changes nothing");

  const first = await migrateExpenseAccounting();
  assert.deepEqual(first.migrated, { repayments: 1, legacyUnclassified: 2, fundingTerminology: 1 });
  assert.equal(first.droppedBrokenReversalIndex, true);
  const legacy = await Expense.find({ expenseId: { $in: ["L1", "L2"] } }).lean();
  assert.ok(legacy.every((expense) => expense.expenseType === "LEGACY_UNCLASSIFIED" && expense.category === undefined));
  const indexNames = (await Expense.collection.indexes()).map((index) => index.name);
  assert.ok(!indexNames.includes("reversalOf_1"));
  assert.ok(indexNames.includes("reversalOf_unique_when_set"));
  assert.ok((await Sale.collection.indexes()).some((index) => index.key["items.mainCategory"] === 1));

  for (let i = 0; i < 2; i += 1) {
    assert.equal((await ctx.expense({ role: "manager", expenseType: "COMPANY_EXPENSE", category: "SHOES", amount: 1 })).status, 201);
  }
  const second = await migrateExpenseAccounting();
  assert.deepEqual(second.migrated, { repayments: 0, legacyUnclassified: 0, fundingTerminology: 0 });
  assert.equal(second.droppedBrokenReversalIndex, false);
});
