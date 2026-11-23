const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { SKIP, createIntegrationContext } = require("./helpers/integrationContext");
const Product = require("../models/Product");
const Sale = require("../models/Sale");
const Customer = require("../models/Customer");

const ctx = createIntegrationContext();
test.before(ctx.setup);
test.after(ctx.teardown);
test.beforeEach(ctx.reset);
const itest = (name, fn) => test(name, { skip: SKIP }, fn);

const PROTECTED = /unitAcquisitionCost|costOfGoodsSold|grossProfit|minimum|floor|Profit/;

async function assertNothingChanged(products, stocks) {
  assert.equal(await Sale.countDocuments(), 0, "no sale was created");
  assert.equal(await Customer.countDocuments(), 0, "no customer was touched");
  for (const [index, product] of products.entries()) {
    assert.equal((await Product.findById(product._id)).stock, stocks[index], "stock is unchanged");
  }
}

// A product sold at 20,000 FC that cost 10,000 FC.
const fcPricedProduct = (mainCategory = "CLOTHES", stock = 50) => ctx.product(mainCategory, 10000, 20000, stock);

const correctionBody = (sale, items, extra = {}) => ({
  isWalkIn: true,
  customer: sale.customer,
  paymentMethod: sale.paymentMethod,
  reason: "correction",
  items,
  ...extra,
});

itest("8. each line has its own boundary: the failing line is identified and nothing is written", async () => {
  const cheapMargin = await ctx.product("CLOTHES", 10, 20, 20);
  const wideMargin = await ctx.product("CLOTHES", 10, 40, 20);
  const response = await ctx.sell([
    { product: cheapMargin, quantity: 3, price: 15 }, // exactly at its floor ($15)
    { product: wideMargin, quantity: 2, price: 24 },  // below its floor ($25)
  ]);
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "PRICE_TOO_LOW");
  assert.equal(response.body.itemIndex, 1);
  assert.equal(response.body.message, "Prix trop bas. Veuillez augmenter le prix.");
  assert.doesNotMatch(JSON.stringify(response.body), /\b(15|25|10)\b|unitCost|minimum/, "no floor, cost or margin in the refusal");
  await assertNothingChanged([cheapMargin, wideMargin], [20, 20]);

  const accepted = await ctx.sell([
    { product: cheapMargin, quantity: 3, price: 15 },
    { product: wideMargin, quantity: 2, price: 25 },
  ]);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
});

itest("6-7, 24. over-discount and below-cost prices are refused before any mutation", async () => {
  const product = await ctx.product("CLOTHES", 10, 20, 20);
  for (const price of [14.99, 9]) {
    const response = await ctx.sell([{ product, quantity: 5, price }]);
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "PRICE_TOO_LOW");
  }
  await assertNothingChanged([product], [20]);
});

itest("14. a discounted SHOES line splits its actual, reduced profit 50/50", async () => {
  const shoes = await ctx.product("SHOES", 10, 20, 20);
  const response = await ctx.sell([{ product: shoes, quantity: 6, price: 16 }]);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const item = (await Sale.findById(response.body._id).lean()).items[0];
  assert.deepEqual(
    [item.revenue, item.costOfGoodsSold, item.grossProfit, item.shoeShareholder1Profit, item.shoeShareholder2Profit, item.clothesShareholderProfit],
    [96, 60, 36, 18, 18, 0]
  );
  assert.deepEqual([item.referenceUnitSellingPrice, item.discountPerUnit, item.discountApplied], [20, 4, true]);
});

itest("15, 17, 19. an item sold at 20,000 FC is recorded, listed and reported at exactly 20,000 FC", async () => {
  const product = await fcPricedProduct();
  const response = await ctx.sell([{ product, quantity: 1, enteredPrice: 20000, enteredCurrency: "FC" }]);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const sale = await Sale.findById(response.body._id).lean();
  assert.deepEqual([sale.currency, sale.exchangeRate, sale.total, sale.totalRevenueFC], ["FC", undefined, 20000, 20000]);
  const stored = sale.items[0];
  assert.deepEqual(
    [stored.price, stored.enteredPrice, stored.priceFC, stored.unitSellingPrice, stored.unitSellingPriceFC, stored.revenue, stored.revenueFC, stored.referenceUnitSellingPriceFC],
    [20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000]
  );
  assert.deepEqual([stored.priceUSD, stored.exchangeRate], [undefined, undefined], "no dollar amount, no rate");
  assert.equal(stored.discountApplied, false, "the normal FC price is not a discount on a one-piece sale");

  const history = await ctx.request("GET", "/sales?type=sale", { token: ctx.token("superadmin") });
  assert.equal(history.body.data[0].items[0].priceFC, 20000);
  assert.equal(history.body.data[0].exchangeRate, undefined);
  assert.deepEqual([history.body.summary.currency, history.body.summary.revenue], ["FC", 20000]);
  const detail = await ctx.request("GET", `/sales/${response.body._id}`, { token: ctx.token("staff") });
  assert.equal(detail.body.data.items[0].enteredPrice, 20000);
  assert.doesNotMatch(JSON.stringify(detail.body.data.items[0]), PROTECTED);
});

itest("16. a discounted 18,000 FC unit price is kept exactly and priced from that amount", async () => {
  const product = await fcPricedProduct("SHOES");
  const response = await ctx.sell([{ product, quantity: 5, enteredPrice: 18000, enteredCurrency: "FC" }]);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const item = (await Sale.findById(response.body._id).lean()).items[0];
  assert.deepEqual([item.enteredPrice, item.priceFC, item.revenue, item.revenueFC], [18000, 18000, 90000, 90000]);
  assert.deepEqual([item.referenceUnitSellingPriceFC, item.discountPerUnitFC, item.discountApplied], [20000, 2000, true]);
  assert.deepEqual([item.costOfGoodsSold, item.grossProfit, item.shoeShareholder1Profit, item.shoeShareholder2Profit], [50000, 40000, 20000, 20000]);
});

itest("22. a dollar amount or a claimed exchange rate cannot get a price under the floor", async () => {
  const product = await fcPricedProduct("CLOTHES", 20);
  // $20 used to be "worth" 57,000 FC; a till still sending dollars is refused.
  const inDollars = await ctx.request("POST", "/sales", {
    token: ctx.token("staff"),
    body: { isWalkIn: true, paymentMethod: "cash", exchangeRate: 2850, items: [{ productId: String(product._id), quantity: 5, price: 20, enteredPrice: 20, enteredCurrency: "USD" }] },
  });
  assert.equal(inDollars.status, 409);
  assert.equal(inDollars.body.error, "CURRENCY_NOT_SUPPORTED");

  // A rate sent with an FC price is ignored: 10,000 FC stays 10,000 FC.
  const claimedRate = await ctx.request("POST", "/sales", {
    token: ctx.token("staff"),
    body: { isWalkIn: true, paymentMethod: "cash", exchangeRate: 500, items: [{ productId: String(product._id), quantity: 5, price: 20, enteredPrice: 10000, enteredCurrency: "FC", exchangeRate: 500 }] },
  });
  assert.equal(claimedRate.status, 400);
  assert.equal(claimedRate.body.error, "PRICE_TOO_LOW");
  await assertNothingChanged([product], [20]);
});

itest("17. a correction is re-priced in FC whatever rate the client sends", async () => {
  const product = await fcPricedProduct();
  const created = await ctx.sell([{ product, quantity: 5, enteredPrice: 18000, enteredCurrency: "FC" }]);
  const sale = await Sale.findById(created.body._id).lean();
  const corrected = await ctx.request("PUT", `/sales/${sale._id}`, {
    token: ctx.token("superadmin"),
    body: correctionBody(sale, [{ _id: sale.items[0]._id, productId: sale.items[0].productId, quantity: 6, price: 1, enteredPrice: 18000, enteredCurrency: "FC", exchangeRate: 100 }], { exchangeRate: 100 }),
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  const after = await Sale.findById(sale._id).lean();
  assert.deepEqual([after.currency, after.exchangeRate, after.total], ["FC", undefined, 108000]);
  assert.deepEqual([after.items[0].exchangeRate, after.items[0].priceFC, after.items[0].revenueFC, after.items[0].priceUSD], [undefined, 18000, 108000, undefined]);
  assert.equal((await Product.findById(product._id)).stock, 44);
});

itest("23. restoring the normal price lets a discounted sale be corrected below 5 pieces", async () => {
  const product = await ctx.product("CLOTHES", 10, 20, 20);
  const created = await ctx.sell([{ product, quantity: 5, price: 15 }]);
  const sale = await Sale.findById(created.body._id).lean();
  const line = { _id: sale.items[0]._id, productId: sale.items[0].productId, quantity: 4 };
  const refused = await ctx.request("PUT", `/sales/${sale._id}`, { token: ctx.token("superadmin"), body: correctionBody(sale, [{ ...line, price: 15, enteredPrice: 15, enteredCurrency: "FC" }]) });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "DISCOUNT_QUANTITY_REQUIRED");
  assert.equal(refused.body.itemIndex, 0);

  const restored = await ctx.request("PUT", `/sales/${sale._id}`, { token: ctx.token("superadmin"), body: correctionBody(sale, [{ ...line, price: 20, enteredPrice: 20, enteredCurrency: "FC" }]) });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const after = await Sale.findById(sale._id).lean();
  assert.deepEqual(
    [after.total, after.costOfGoodsSold, after.grossProfit, after.clothesShareholderProfit, after.items[0].discountApplied, after.items[0].discountPerUnit],
    [80, 40, 40, 40, false, 0]
  );
  assert.equal((await Product.findById(product._id)).stock, 16, "one piece returned to stock");
  assert.ok(after.editHistory.at(-1).changes.financials, "the correction is audited");
});

itest("a retried submission with the same request key records exactly one sale", async () => {
  const product = await ctx.product("CLOTHES", 10, 20, 20);
  const first = await ctx.sell([{ product, quantity: 2 }], { requestKey: "pos-key-1" });
  const retry = await ctx.sell([{ product, quantity: 2 }], { requestKey: "pos-key-1" });
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(retry.body._id, first.body._id);
  assert.equal(await Sale.countDocuments(), 1);
  assert.equal((await Product.findById(product._id)).stock, 18);

  const reused = await ctx.sell([{ product, quantity: 3 }], { requestKey: "pos-key-1" });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error, "IDEMPOTENCY_CONFLICT");

  const concurrent = await Promise.all([1, 2, 3].map(() => ctx.sell([{ product, quantity: 1 }], { requestKey: "pos-key-2" })));
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 200, 201]);
  assert.equal(await Sale.countDocuments(), 2);
  assert.equal((await Product.findById(product._id)).stock, 17);
});

itest("an offline sale queued before the cutover is recorded in FC with its retry identity", async () => {
  const product = await fcPricedProduct("CLOTHES", 10);
  const occurredAt = new Date(Date.now() - 60 * 60 * 1000);
  // The till priced it in FC and still sends the rate it used then: ignored.
  const body = {
    isWalkIn: true, paymentMethod: "cash", offline: true, occurredAt: occurredAt.toISOString(),
    exchangeRate: 2850, requestKey: "offline-sale-key", clientSaleId: "offline-sale-key", receiptNumber: "POS-offline-sale-key",
    items: [{ productId: String(product._id), quantity: 2, price: 20000 / 2850, enteredPrice: 20000, enteredCurrency: "FC", exchangeRate: 2850 }],
  };
  const first = await ctx.request("POST", "/sales", { token: ctx.token("staff"), body });
  const retry = await ctx.request("POST", "/sales", { token: ctx.token("staff"), body });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body._id, first.body._id);
  assert.deepEqual([first.body.currency, first.body.exchangeRate, first.body.total], ["FC", undefined, 40000]);
  assert.equal(first.body.receiptNumber, "POS-offline-sale-key");
  assert.equal(await Sale.countDocuments({ requestKey: "offline-sale-key" }), 1);
  assert.equal((await Product.findById(product._id)).stock, 8);
});

itest("20, 25. a dollar sale recorded before the cutover is shown in FC from its own snapshot, never rewritten, and correctable", async () => {
  const product = await ctx.product("CLOTHES", 14250, 22800, 20);
  const legacyId = new mongoose.Types.ObjectId();
  const itemId = new mongoose.Types.ObjectId();
  // A pre-migration record: exact FC entry, cent-rounded USD, no revenueFC,
  // no totalRevenueFC and no reference/discount snapshot.
  await Sale.collection.insertOne({
    _id: legacyId, saleId: "SALE-LEGACY-FC", saleNumber: "SN-LEGACY-FC", status: "completed", type: "sale",
    salesPerson: "Admin", paymentMethod: "cash", customer: { name: "Client de passage", phone: "", email: "" }, isWalkIn: true,
    exchangeRate: 2850, subtotal: 7.02, total: 7.02, totalRevenue: 7.02, costOfGoodsSold: 5, grossProfit: 2.02,
    items: [{
      _id: itemId, productId: product._id, name: product.name, quantity: 1, price: 20000 / 2850, total: 7.02,
      enteredPrice: 20000, enteredCurrency: "FC", priceUSD: 20000 / 2850, priceFC: 20000, exchangeRate: 2850,
      unitSellingPrice: 7.02, unitAcquisitionCost: 5, revenue: 7.02, costOfGoodsSold: 5, grossProfit: 2.02, mainCategory: "CLOTHES",
    }],
    createdAt: new Date(), updatedAt: new Date(),
  });
  const raw = await Sale.collection.findOne({ _id: legacyId });

  const history = await ctx.request("GET", "/sales", { token: ctx.token("superadmin") });
  assert.equal(history.status, 200);
  assert.equal(history.body.summary.revenue, 20000, "the FC that was entered, not 7.02 x 2,850 = 20,007");
  const listed = history.body.data.find((sale) => sale._id === String(legacyId));
  assert.deepEqual([listed.currency, listed.total, listed.exchangeRate, listed.items[0].price], ["FC", 20000, undefined, 20000]);
  const balance = await ctx.balance("CLOTHES");
  assert.deepEqual([balance.revenue, balance.costOfGoodsSold, balance.grossProfit], [20000, 14250, 5750], "COGS $5 at its own rate of 2,850");
  assert.deepEqual(await Sale.collection.findOne({ _id: legacyId }), raw, "reading never rewrites history");

  // Its below-list historical price is not reinterpreted as a new discount.
  const legacy = await Sale.findById(legacyId).lean();
  const corrected = await ctx.request("PUT", `/sales/${legacyId}`, {
    token: ctx.token("superadmin"),
    body: correctionBody(legacy, [{ _id: itemId, productId: product._id, quantity: 1, price: 20000, enteredPrice: 20000, enteredCurrency: "FC" }]),
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  const after = (await Sale.findById(legacyId).lean()).items[0];
  // A correction re-records the sale in FC, keeping the historical cost.
  assert.deepEqual([after.priceFC, after.exchangeRate, after.discountApplied, after.referenceUnitSellingPriceFC], [20000, undefined, false, 20000]);
  assert.deepEqual([after.unitAcquisitionCost, after.costOfGoodsSold, after.grossProfit], [14250, 14250, 5750]);
});
