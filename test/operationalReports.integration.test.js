const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { SKIP, createIntegrationContext } = require("./helpers/integrationContext");
const StockMovement = require("../models/StockMovement");
const Product = require("../models/Product");
const Sale = require("../models/Sale");
const { ensureStockBaselines } = require("../services/stockMovementService");
const { currentBusinessDate } = require("../utils/queryHelpers");

const ctx = createIntegrationContext();
test.before(ctx.setup);
test.after(ctx.teardown);
test.beforeEach(ctx.reset);
const itest = (name, fn) => test(name, { skip: SKIP }, fn);

// Business day 2026-09-10 (UTC+2) starts at 2026-09-09T22:00:00.000Z and
// 2026-09-11 ends at 2026-09-11T21:59:59.999Z.
const PERIOD = "from=2026-09-10&to=2026-09-11";
const START = "2026-09-09T22:00:00.000Z";
const END = "2026-09-11T21:59:59.999Z";

// Inserts a product's ledger, chaining balances in the given order.
async function ledger(product, entries, category = product.mainCategory) {
  let balance = 0;
  await StockMovement.insertMany(entries.map(([kind, quantityDelta, iso]) => {
    const row = {
      productId: product._id, productName: product.name, mainCategory: category, unit: "pcs",
      quantityDelta, balanceBefore: kind === "BASELINE" ? quantityDelta : balance, kind, occurredAt: new Date(iso),
    };
    balance = kind === "BASELINE" ? quantityDelta : balance + quantityDelta;
    return { ...row, quantityDelta: kind === "BASELINE" ? 0 : quantityDelta, balanceAfter: balance };
  }));
}
const stockSheet = (query, role = "superadmin") => ctx.request("GET", `/products/stock-sheet?${query}`, { token: ctx.token(role) });
const salesSheet = (query, role = "superadmin") => ctx.request("GET", `/analytics/sales-sheet?${query}`, { token: ctx.token(role) });
const pick = (row) => [row.openingStock, row.additions, row.reductions, row.salesOut, row.closingStock];
const identityHolds = (row) => row.openingStock + row.additions - row.reductions - row.salesOut === row.closingStock;

// ----------------------------------------------------------------- stock sheet

itest("stock sheet derives opening, period changes and closing from the ledger at exact boundaries", async () => {
  const moving = await ctx.product("CLOTHES", 10, 20, 10);
  const idle = await ctx.product("CLOTHES", 10, 20, 7);
  const created = await ctx.product("CLOTHES", 10, 20, 5);
  const shoes = await ctx.product("SHOES", 10, 20, 9);
  await ledger(moving, [
    ["INITIAL", 10, "2026-09-01T08:00:00Z"],
    ["MANUAL_ADJUSTMENT", 5, "2026-09-09T21:59:59.999Z"], // last ms before the period: opening
    ["SALE", -3, START], // first ms of the period
    ["MANUAL_ADJUSTMENT", -2, "2026-09-10T08:00:00Z"],
    ["SALE_VOID", 1, "2026-09-10T09:00:00Z"],
    ["MANUAL_ADJUSTMENT", 4, END], // last ms of the period
    ["SALE", -5, "2026-09-11T22:00:00.000Z"], // first ms after the period
  ]);
  await ledger(idle, [["INITIAL", 7, "2026-09-01T08:00:00Z"]]);
  await ledger(created, [["INITIAL", 6, "2026-09-10T10:00:00Z"], ["SALE", -1, "2026-09-10T11:00:00Z"]]);
  await ledger(shoes, [["INITIAL", 9, "2026-09-01T08:00:00Z"], ["SALE", -2, "2026-09-10T08:00:00Z"]]);

  const response = await stockSheet(`${PERIOD}&category=CLOTHES`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.category, "CLOTHES");
  assert.equal(response.body.complete, true);
  const row = (product) => response.body.rows.find((item) => item.productId === String(product._id));
  assert.deepEqual(pick(row(moving)), [15, 4, 2, 2, 15], "opening 15 + 4 - 2 - (3 sold - 1 voided) = 15");
  assert.deepEqual(pick(row(idle)), [7, 0, 0, 0, 7], "no movement: opening equals closing");
  assert.deepEqual(pick(row(created)), [0, 6, 0, 1, 5], "created in the period opens at zero");
  assert.equal(row(shoes), undefined, "SHOES never appears in a CLOTHES sheet");
  for (const item of response.body.rows) assert.ok(identityHolds(item), item.product);
  assert.deepEqual(
    [response.body.totals.openingStock, response.body.totals.additions, response.body.totals.reductions, response.body.totals.salesOut, response.body.totals.closingStock],
    [22, 10, 2, 3, 27],
  );

  // The day before the period ends right before the boundary sale.
  const dayBefore = await stockSheet("from=2026-09-09&to=2026-09-09&category=CLOTHES");
  assert.deepEqual(pick(dayBefore.body.rows.find((item) => item.productId === String(moving._id))), [10, 5, 0, 0, 15]);
});

itest("the stock sheet API reflects real product, sale and void workflows", async () => {
  await ctx.setRate(2850);
  const created = await ctx.request("POST", "/products", {
    token: ctx.token("superadmin"),
    body: {
      name: "Robe flux", mainCategory: "CLOTHES", subcategory: "Robes", purchasedQuantity: 10, stock: 10,
      priceEnteredAmount: 20, priceEnteredCurrency: "USD", priceExchangeRate: 2850,
      unitCostEnteredAmount: 10, unitCostEnteredCurrency: "USD", unitCostExchangeRate: 2850,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body._id;
  const edit = (stock) => ctx.request("PUT", `/products/${id}`, { token: ctx.token("superadmin"), body: { stock } });
  assert.equal((await edit(15)).status, 200);
  assert.equal((await edit(12)).status, 200);
  const product = await Product.findById(id);
  const sold = await ctx.sell([{ product, quantity: 4 }], { exchangeRate: 2850 });
  assert.equal(sold.status, 201, JSON.stringify(sold.body));
  assert.equal((await ctx.request("PATCH", `/sales/${sold.body._id}/void`, { token: ctx.token("superadmin"), body: { reason: "test" } })).status, 200);
  assert.equal((await ctx.sell([{ product, quantity: 2 }], { exchangeRate: 2850 })).status, 201);

  const today = currentBusinessDate();
  const response = await stockSheet(`from=${today}&to=${today}&category=CLOTHES`);
  const row = response.body.rows.find((item) => item.productId === id);
  assert.deepEqual(pick(row), [0, 15, 3, 2, 10]);
  assert.equal(row.closingStock, (await Product.findById(id)).stock, "closing equals the authoritative product stock");
  assert.deepEqual(
    (await StockMovement.find({ productId: id }).sort({ occurredAt: 1, _id: 1 }).lean()).map((m) => m.kind),
    ["INITIAL", "MANUAL_ADJUSTMENT", "MANUAL_ADJUSTMENT", "SALE", "SALE_VOID", "SALE"],
  );
});

itest("category transfers and deletions keep CLOTHES and SHOES streams separate", async () => {
  await ctx.setRate(2850);
  const body = (name) => ({
    name, mainCategory: "CLOTHES", subcategory: "Test", purchasedQuantity: 8, stock: 8,
    priceEnteredAmount: 20, priceEnteredCurrency: "USD", priceExchangeRate: 2850,
    unitCostEnteredAmount: 10, unitCostEnteredCurrency: "USD", unitCostExchangeRate: 2850,
  });
  const moved = await ctx.request("POST", "/products", { token: ctx.token("superadmin"), body: body("Moved") });
  const removed = await ctx.request("POST", "/products", { token: ctx.token("superadmin"), body: body("Removed") });
  const transfer = await ctx.request("PUT", `/products/${moved.body._id}`, { token: ctx.token("superadmin"), body: { mainCategory: "SHOES", stock: 11 } });
  assert.equal(transfer.status, 200, JSON.stringify(transfer.body));
  assert.equal((await ctx.request("DELETE", `/products/${removed.body._id}`, { token: ctx.token("superadmin") })).status, 200);

  const today = currentBusinessDate();
  const all = await stockSheet(`from=${today}&to=${today}`);
  const rows = (id) => all.body.rows.filter((item) => item.productId === id);
  const [clothesRow] = rows(moved.body._id).filter((item) => item.category === "CLOTHES");
  const [shoesRow] = rows(moved.body._id).filter((item) => item.category === "SHOES");
  assert.deepEqual(pick(clothesRow), [0, 8, 8, 0, 0], "the CLOTHES stream closes at zero");
  assert.deepEqual(pick(shoesRow), [0, 11, 0, 0, 11], "the SHOES stream opens with the transferred stock");
  const [deletedRow] = rows(removed.body._id);
  assert.deepEqual(pick(deletedRow), [0, 8, 8, 0, 0]);
  assert.equal(deletedRow.status, "deleted");
  assert.equal(deletedRow.product, "Removed", "deleted products keep their ledger name");

  const clothesShareholder = await stockSheet(`from=${today}&to=${today}&category=SHOES`, "clothesShareholder");
  assert.equal(clothesShareholder.body.category, "CLOTHES");
  assert.ok(clothesShareholder.body.rows.length > 0);
  assert.ok(clothesShareholder.body.rows.every((item) => item.category === "CLOTHES"));
  const shoesShareholder = await stockSheet(`from=${today}&to=${today}`, "shoesShareholder");
  assert.deepEqual(shoesShareholder.body.rows.map((item) => [item.productId, item.category]), [[moved.body._id, "SHOES"]]);
});

itest("streams closed before the period are omitted, and legacy products are flagged instead of invented", async () => {
  const gone = await ctx.product("CLOTHES", 10, 20, 4);
  await ledger(gone, [["INITIAL", 4, "2026-09-01T08:00:00Z"], ["PRODUCT_DELETE", -4, "2026-09-05T08:00:00Z"]]);
  await Product.deleteOne({ _id: gone._id });

  const legacy = await ctx.product("CLOTHES", 10, 20, 7);
  await Product.collection.updateOne({ _id: legacy._id }, { $set: { createdAt: new Date("2026-09-01T08:00:00Z") } });
  const notYetCreated = await ctx.product("CLOTHES", 10, 20, 3);
  await Product.collection.updateOne({ _id: notYetCreated._id }, { $set: { createdAt: new Date("2026-09-20T08:00:00Z") } });

  const response = await stockSheet(`${PERIOD}&category=CLOTHES`);
  assert.equal(response.body.rows.find((item) => item.productId === String(gone._id)), undefined);
  assert.equal(response.body.rows.find((item) => item.productId === String(notYetCreated._id)), undefined);
  const row = response.body.rows.find((item) => item.productId === String(legacy._id));
  assert.equal(row.trackingComplete, false);
  assert.equal(row.openingStock, null);
  assert.equal(row.closingStock, null);
  assert.equal(response.body.complete, false);

  // The boot-time baseline starts tracking now: later periods are complete,
  // periods before the baseline stay flagged.
  assert.ok(await ensureStockBaselines() >= 1);
  const today = currentBusinessDate();
  const current = await stockSheet(`from=${today}&to=${today}&category=CLOTHES`);
  const baselineRow = current.body.rows.find((item) => item.productId === String(legacy._id));
  assert.equal(baselineRow.trackingComplete, false, "the baseline day itself has no opening balance");
  assert.equal(baselineRow.closingStock, 7);
  const tomorrow = new Date(Date.now() + 26 * 3600 * 1000).toISOString().slice(0, 10);
  const later = await stockSheet(`from=${tomorrow}&to=${tomorrow}&category=CLOTHES`);
  assert.deepEqual(pick(later.body.rows.find((item) => item.productId === String(legacy._id))), [7, 0, 0, 0, 7]);
});

itest("report endpoints reject invalid dates and unauthenticated access", async () => {
  assert.equal((await stockSheet("from=2026-13-01&to=2026-13-02")).status, 400);
  assert.equal((await salesSheet("from=2026-09-12&to=2026-09-10")).status, 400);
  assert.equal((await ctx.request("GET", "/products/stock-sheet")).status, 401);
  assert.equal((await ctx.request("GET", "/analytics/sales-sheet")).status, 401);
});

// ----------------------------------------------------------------- sales sheet

itest("sales sheet counts recognized sales only and isolates shareholder categories", async () => {
  const clothes = await ctx.product("CLOTHES", 10, 20, 20);
  const shoes = await ctx.product("SHOES", 10, 20, 20);
  await ctx.sell([{ product: clothes, quantity: 2 }], { exchangeRate: 2850 });
  await ctx.sell([{ product: shoes, quantity: 1 }], { exchangeRate: 2850 });
  await ctx.sell([{ product: shoes, quantity: 3 }], { type: "reservation", exchangeRate: 2850, customer: { name: "Client", phone: "0992000001" } });
  const superadmin = await salesSheet("from=2020-01-01&to=2030-01-01");
  assert.equal(superadmin.status, 200);
  assert.equal(superadmin.body.summary.unitsSold, 3, "pending reservation is excluded");
  assert.equal(superadmin.body.summary.skusSold, 2);
  const clothesRow = superadmin.body.rows.find((row) => row.productId === String(clothes._id));
  assert.deepEqual([clothesRow.quantitySold, clothesRow.unit, clothesRow.revenue.usd, clothesRow.revenue.fc], [2, "pcs", 40, 114000]);

  const shareholder = await salesSheet("from=2020-01-01&to=2030-01-01&category=SHOES", "clothesShareholder");
  assert.equal(shareholder.status, 200);
  assert.equal(shareholder.body.category, "CLOTHES");
  assert.deepEqual(shareholder.body.rows.map((row) => [row.category, row.quantitySold]), [["CLOTHES", 2]]);
  const shoesOnly = await salesSheet("from=2020-01-01&to=2030-01-01", "shoesShareholder");
  assert.deepEqual(shoesOnly.body.rows.map((row) => [row.category, row.quantitySold]), [["SHOES", 1]]);
});

itest("a mixed CLOTHES/SHOES sale only contributes the requested category's lines", async () => {
  const clothes = await ctx.product("CLOTHES", 10, 20, 20);
  const shoes = await ctx.product("SHOES", 10, 20, 20);
  await ctx.sell([{ product: clothes, quantity: 1 }, { product: shoes, quantity: 4 }], { exchangeRate: 2850 });
  const response = await salesSheet("from=2020-01-01&to=2030-01-01&category=SHOES");
  assert.deepEqual(response.body.rows.map((row) => [row.productId, row.quantitySold]), [[String(shoes._id), 4]]);
});

itest("sales sheet uses recognition dates and excludes voided, refunded and corrected records", async () => {
  const product = await ctx.product("CLOTHES", 10, 20, 40);
  const completed = await ctx.sell([{ product, quantity: 2 }], { exchangeRate: 2850, requestKey: "report-completed" });
  const pending = await ctx.sell([{ product, quantity: 3 }], { type: "reservation", exchangeRate: 2850, customer: { name: "Client", phone: "0992000002" } });
  const voided = await ctx.sell([{ product, quantity: 4 }], { exchangeRate: 2850, requestKey: "report-voided" });
  const refunded = await ctx.sell([{ product, quantity: 5 }], { exchangeRate: 2850, requestKey: "report-refunded" });
  const corrected = await ctx.sell([{ product, quantity: 6 }], { exchangeRate: 2850, requestKey: "report-corrected" });
  const day10 = new Date("2026-09-10T10:00:00Z");
  const day11 = new Date("2026-09-11T10:00:00Z");
  const objectId = (value) => new mongoose.Types.ObjectId(value);
  await Sale.collection.updateOne({ _id: objectId(completed.body._id) }, { $set: { createdAt: day10 } });
  await Sale.collection.updateOne({ _id: objectId(pending.body._id) }, { $set: { status: "completed", createdAt: day10, completedAt: day11 } });
  await Sale.collection.updateOne({ _id: objectId(voided.body._id) }, { $set: { status: "voided", createdAt: day10 } });
  await Sale.collection.updateOne({ _id: objectId(refunded.body._id) }, { $set: { status: "refunded", createdAt: day10 } });
  await Sale.collection.updateOne({ _id: objectId(corrected.body._id) }, { $set: { status: "corrected", createdAt: day10 } });
  const firstDay = await salesSheet("from=2026-09-10&to=2026-09-10&category=CLOTHES");
  assert.equal(firstDay.body.summary.unitsSold, 2);
  const secondDay = await salesSheet("from=2026-09-11&to=2026-09-11&category=CLOTHES");
  assert.equal(secondDay.body.summary.unitsSold, 3, "completed reservation uses completedAt");
});

itest("a voided sale disappears from the sales sheet through the real void workflow", async () => {
  const product = await ctx.product("CLOTHES", 10, 20, 10);
  const sold = await ctx.sell([{ product, quantity: 3 }], { exchangeRate: 2850 });
  const today = currentBusinessDate();
  assert.equal((await salesSheet(`from=${today}&to=${today}`)).body.summary.unitsSold, 3);
  await ctx.request("PATCH", `/sales/${sold.body._id}/void`, { token: ctx.token("superadmin"), body: { reason: "test" } });
  assert.equal((await salesSheet(`from=${today}&to=${today}`)).body.summary.unitsSold, 0);
});

itest("sales sheet date boundaries are inclusive to the millisecond in business time", async () => {
  const product = await ctx.product("CLOTHES", 10, 20, 40);
  const objectId = (value) => new mongoose.Types.ObjectId(value);
  const at = async (iso, quantity) => {
    const sale = await ctx.sell([{ product, quantity }], { exchangeRate: 2850 });
    await Sale.collection.updateOne({ _id: objectId(sale.body._id) }, { $set: { createdAt: new Date(iso) } });
  };
  await at("2026-09-09T21:59:59.999Z", 1); // business day 2026-09-09
  await at(START, 2);
  await at(END, 4);
  await at("2026-09-11T22:00:00.000Z", 8); // business day 2026-09-12
  assert.equal((await salesSheet(`${PERIOD}&category=CLOTHES`)).body.summary.unitsSold, 6);
  assert.equal((await salesSheet("from=2026-09-09&to=2026-09-09")).body.summary.unitsSold, 1);
  assert.equal((await salesSheet("from=2026-09-12&to=2026-09-12")).body.summary.unitsSold, 8);
});

itest("an offline sale synchronised several times is counted once", async () => {
  const product = await ctx.product("SHOES", 10, 20, 20);
  await ctx.setRate(2850);
  const body = {
    isWalkIn: true, paymentMethod: "cash", exchangeRate: 2850, requestKey: "offline-sync-1", clientSaleId: "offline-sync-1",
    offline: true, occurredAt: new Date().toISOString(),
    items: [{ productId: String(product._id), quantity: 2, price: 20, enteredPrice: 20, enteredCurrency: "USD", exchangeRate: 2850 }],
  };
  const first = await ctx.request("POST", "/sales", { token: ctx.token("staff"), body });
  const retry = await ctx.request("POST", "/sales", { token: ctx.token("staff"), body });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(retry.status, 200);
  const today = currentBusinessDate();
  const response = await salesSheet(`from=${today}&to=${today}&category=SHOES`);
  assert.equal(response.body.summary.unitsSold, 2);
  assert.equal(await StockMovement.countDocuments({ productId: product._id, kind: "SALE" }), 1);
});
