const mongoose = require("mongoose");
const { startReplicaSet, findMongod } = require("./mongoReplicaSet");
const { startApp, createUser } = require("./testApp");
const Sale = require("../../models/Sale");
const Expense = require("../../models/Expense");
const Product = require("../../models/Product");
const Customer = require("../../models/Customer");
const Entry = require("../../models/Entry");
const ExchangeRate = require("../../models/ExchangeRate");
const User = require("../../models/User");
const AccountingLock = require("../../models/AccountingLock");
const { aggregateCategoryAccounting, ensureAccountingLocks } = require("../../services/financialAccountingService");
const { discountProbeGuard } = require("../../utils/discountProbeGuard");

const SKIP = process.env.SKIP_DB_TESTS
  ? "SKIP_DB_TESTS is set"
  : findMongod() ? false : "mongod binary not found (set MONGOD_PATH to run integration tests)";

function createIntegrationContext() {
  const ctx = { users: {} };
  let replicaSet;
  let productCounter = 0;

  ctx.setup = async () => {
    if (SKIP) return;
    replicaSet = await startReplicaSet();
    await mongoose.connect(replicaSet.uri);
    await Promise.all([Sale, Expense, Product, Customer, Entry, ExchangeRate, User, AccountingLock].map((model) => model.init()));
    await ensureAccountingLocks();
    ctx.app = await startApp();
    for (const role of ["superadmin", "manager", "inventory_manager", "cashier_supervisor", "staff"]) {
      ctx.users[role] = await createUser(role);
    }
    ctx.users.clothesShareholder = await createUser("admin", { assignedCategory: "CLOTHES", permissions: ["/reports", "/sales", "/products"] });
    ctx.users.shoesShareholder = await createUser("admin", { assignedCategory: "SHOES", permissions: ["/reports", "/sales", "/products"] });
  };

  ctx.teardown = async () => {
    if (SKIP) return;
    await ctx.app?.close();
    await mongoose.disconnect();
    await replicaSet?.stop();
  };

  ctx.reset = async () => {
    if (SKIP) return;
    await Promise.all([Sale, Expense, Product, Customer, Entry, ExchangeRate].map((model) => model.deleteMany({})));
    discountProbeGuard.reset();
  };

  ctx.request = (...args) => ctx.app.request(...args);
  ctx.token = (role) => ctx.users[role].token;

  ctx.product = async (mainCategory, unitCost, price, stock = 1000) => {
    productCounter += 1;
    return Product.create({
      name: `${mainCategory}-${productCounter}`, category: "test", mainCategory, price,
      purchasedQuantity: stock, totalAcquisitionCost: unitCost * stock, unitCost, stock, minStock: 0,
    });
  };

  // The server only accepts the rate that is active in the database (the POS
  // reads it from /exchange-rates/current), so a test rate is activated first.
  ctx.setRate = async (rate) => {
    const current = await ExchangeRate.getCurrentRate();
    if (current?.rate === rate) return current;
    await ExchangeRate.updateMany({ isActive: true }, { $set: { isActive: false } });
    return ExchangeRate.create({ rate, createdBy: ctx.users.superadmin.user._id, isActive: true, effectiveFrom: new Date() });
  };

  ctx.sell = async (items, { role = "staff", type = "sale", paymentMethod = "cash", exchangeRate, customer, requestKey } = {}) => {
    if (exchangeRate !== undefined) await ctx.setRate(exchangeRate);
    const body = {
      items: items.map(({ product, quantity = 1, price, enteredPrice, enteredCurrency }) => ({
        productId: String(product._id), quantity, price: price ?? product.price,
        ...(enteredCurrency ? { enteredPrice, enteredCurrency } : {}),
      })),
      paymentMethod, type, exchangeRate, requestKey,
      ...(type === "reservation" || customer ? { customer: customer || { name: "Client", phone: `09${Math.floor(Math.random() * 1e8)}` } } : { isWalkIn: true }),
    };
    return ctx.request("POST", "/sales", { token: ctx.token(role), body });
  };

  ctx.expense = async ({ role = "superadmin", expenseType, category, amount, enteredCurrency, exchangeRate, requestKey, reason = "test" }) => ctx.request("POST", "/expenses", {
    token: ctx.token(role),
    body: {
      reason, recipientName: "Fournisseur", recipientPhone: "0990000000", amount,
      expenseType, category, requestKey,
      ...(enteredCurrency ? { enteredCurrency, enteredAmount: amount, exchangeRate } : {}),
    },
  });

  ctx.validate = (id, role = "manager") => ctx.request("PATCH", `/expenses/${id}/validate`, { token: ctx.token(role), body: {} });
  ctx.balance = (category) => aggregateCategoryAccounting(category);

  // Moves a record into the past (business UTC+2), bypassing timestamps.
  ctx.backdate = async (Model, id, isoDate, extra = {}) => {
    await Model.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(id)) }, { $set: { createdAt: new Date(isoDate), ...extra } });
  };
  return ctx;
}

const cents = (value) => Math.round(Number(value) * 100);

module.exports = { SKIP, createIntegrationContext, cents };
