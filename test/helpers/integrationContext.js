const mongoose = require("mongoose");
const { startReplicaSet, findMongod } = require("./mongoReplicaSet");
const { startApp, createUser } = require("./testApp");
const Sale = require("../../models/Sale");
const Expense = require("../../models/Expense");
const Product = require("../../models/Product");
const Customer = require("../../models/Customer");
const Entry = require("../../models/Entry");
const User = require("../../models/User");
const AccountingLock = require("../../models/AccountingLock");
const StockMovement = require("../../models/StockMovement");
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
    await Promise.all([Sale, Expense, Product, Customer, Entry, User, AccountingLock, StockMovement].map((model) => model.init()));
    await ensureAccountingLocks();
    ctx.app = await startApp();
    for (const role of ["superadmin", "manager", "inventory_manager", "cashier_supervisor"]) {
      ctx.users[role] = await createUser(role);
    }
    // "staff" has no module by default (same rule as the interface); the test
    // cashier is granted the POS and Sales History, like a real cashier.
    ctx.users.staff = await createUser("staff", { permissions: ["/", "/sales"] });
    ctx.users.bareStaff = await createUser("staff");
    // A manager explicitly granted the Reports module (not a default).
    ctx.users.reportsManager = await createUser("manager", { permissions: ["/", "/sales", "/products", "/reports"] });
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
    await Promise.all([Sale, Expense, Product, Customer, Entry, StockMovement].map((model) => model.deleteMany({})));
    discountProbeGuard.reset();
  };

  ctx.request = (...args) => ctx.app.request(...args);
  ctx.token = (role) => ctx.users[role].token;

  ctx.product = async (mainCategory, unitCost, price, stock = 1000) => {
    productCounter += 1;
    // An FC product, exactly as the Products API now records one.
    return Product.create({
      name: `${mainCategory}-${productCounter}`, category: "test", mainCategory, currency: "FC",
      price, priceFC: price, priceEnteredAmount: price, priceEnteredCurrency: "FC",
      unitCost, unitCostFC: unitCost, unitCostEnteredAmount: unitCost, unitCostEnteredCurrency: "FC",
      purchasedQuantity: stock, totalAcquisitionCost: unitCost * stock, totalAcquisitionCostFC: unitCost * stock, stock, minStock: 0,
    });
  };

  // Every amount is in Congolese francs (FC): there is no exchange rate any
  // more. A line may carry its entered FC price (enteredPrice) explicitly.
  ctx.sell = async (items, { role = "staff", type = "sale", paymentMethod = "cash", customer, requestKey } = {}) => {
    const body = {
      items: items.map(({ product, quantity = 1, price, enteredPrice, enteredCurrency }) => ({
        productId: String(product._id), quantity, price: enteredPrice ?? price ?? product.price,
        ...(enteredCurrency ? { enteredPrice: enteredPrice ?? price, enteredCurrency } : {}),
      })),
      paymentMethod, type, currency: "FC", requestKey,
      ...(type === "reservation" || customer ? { customer: customer || { name: "Client", phone: `09${Math.floor(Math.random() * 1e8)}` } } : { isWalkIn: true }),
    };
    if (type === "reservation") {
      // Reservations can no longer be created through the API (the module was
      // retired); legacy pending reservations are reproduced by recording the
      // sale and turning it into the historical record shape.
      const created = await ctx.request("POST", "/sales", { token: ctx.token(role), body: { ...body, type: "sale" } });
      if (created.status !== 201) return created;
      await Sale.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(created.body._id)) }, { $set: { type: "reservation", status: "pending" } });
      return { ...created, body: { ...created.body, type: "reservation", status: "pending" } };
    }
    return ctx.request("POST", "/sales", { token: ctx.token(role), body });
  };

  ctx.expense = async ({ role = "superadmin", expenseType, category, amount, enteredCurrency, requestKey, reason = "test" }) => ctx.request("POST", "/expenses", {
    token: ctx.token(role),
    body: {
      reason, recipientName: "Fournisseur", recipientPhone: "0990000000", amount,
      expenseType, category, requestKey,
      ...(enteredCurrency ? { enteredCurrency, enteredAmount: amount } : {}),
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
