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

// A product whose selling price was defined as 20,000 FC at 2,850 FC/USD.
async function fcPricedProduct(mainCategory = "CLOTHES", stock = 50) {
  const product = await ctx.product(mainCategory, 10000 / 2850, 20000 / 2850, stock);
  return Product.findByIdAndUpdate(product._id, {
    priceEnteredAmount: 20000, priceEnteredCurrency: "FC", priceFC: 20000, priceExchangeRate: 2850,
  }, { new: true });
}

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

itest("15, 17, 19. an FC-priced item sold at 20,000 FC stays 20,000 FC after the rate changes", async () => {
  const product = await fcPricedProduct();
  const response = await ctx.sell(
    [{ product, quantity: 1, price: 20000 / 2850, enteredPrice: 20000, enteredCurrency: "FC" }],
    { exchangeRate: 2850 }
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const stored = (await Sale.findById(response.body._id).lean()).items[0];
  assert.deepEqual(
    [stored.enteredPrice, stored.priceFC, stored.unitSellingPriceFC, stored.revenueFC, stored.referenceUnitSellingPriceFC],
    [20000, 20000, 20000, 20000, 20000]
  );
  assert.equal(stored.discountApplied, false, "the normal FC price is not a discount on a one-piece sale");
  assert.equal(stored.unitSellingPrice, 7.02, "USD accounting is rounded once to the cent");
  assert.notEqual(Math.round(stored.unitSellingPrice * 2850), 20000, "reconstructing FC from USD would drift");

  await ctx.setRate(2900);
  const history = await ctx.request("GET", "/sales?type=sale", { token: ctx.token("superadmin") });
  assert.equal(history.body.data[0].items[0].priceFC, 20000);
  assert.equal(history.body.data[0].exchangeRate, 2850);
  assert.equal(history.body.summary.revenueFC, 20000);
  const detail = await ctx.request("GET", `/sales/${response.body._id}`, { token: ctx.token("staff") });
  assert.equal(detail.body.data.items[0].enteredPrice, 20000);
  assert.doesNotMatch(JSON.stringify(detail.body.data.items[0]), PROTECTED);
});

itest("16. a discounted 18,000 FC unit price is kept exactly and priced from that amount", async () => {
  const product = await fcPricedProduct("SHOES");
  const response = await ctx.sell(
    [{ product, quantity: 5, price: 18000 / 2850, enteredPrice: 18000, enteredCurrency: "FC" }],
    { exchangeRate: 2850 }
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const item = (await Sale.findById(response.body._id).lean()).items[0];
  assert.deepEqual([item.enteredPrice, item.priceFC, item.revenueFC], [18000, 18000, 90000]);
  assert.deepEqual([item.referenceUnitSellingPriceFC, item.discountPerUnitFC, item.discountApplied], [20000, 2000, true]);
  assert.equal(item.revenue, 31.6, "5 x $6.32 (18,000 FC / 2,850 rounded to the cent)");
});

itest("22. a forged exchange rate cannot shrink an FC price under the floor", async () => {
  await ctx.setRate(2850);
  const product = await ctx.product("CLOTHES", 10, 20, 20);
  // 10,000 FC is $3.51 at the real rate; claiming 500 FC/USD would make it $20.
  const forged = await ctx.request("POST", "/sales", {
    token: ctx.token("staff"),
    body: { isWalkIn: true, paymentMethod: "cash", exchangeRate: 500, items: [{ productId: String(product._id), quantity: 1, price: 20, enteredPrice: 10000, enteredCurrency: "FC" }] },
  });
  assert.equal(forged.status, 409);
  assert.equal(forged.body.error, "EXCHANGE_RATE_CHANGED");
  assert.equal(forged.body.exchangeRate, 2850);

  const forgedItemRate = await ctx.request("POST", "/sales", {
    token: ctx.token("staff"),
    body: { isWalkIn: true, paymentMethod: "cash", items: [{ productId: String(product._id), quantity: 1, price: 20, enteredPrice: 10000, enteredCurrency: "FC", exchangeRate: 500 }] },
  });
  assert.equal(forgedItemRate.status, 409);

  // Without a claimed rate the server applies its own: the true value is too low.
  const honest = await ctx.request("POST", "/sales", {
    token: ctx.token("staff"),
    body: { isWalkIn: true, paymentMethod: "cash", items: [{ productId: String(product._id), quantity: 5, price: 20, enteredPrice: 10000, enteredCurrency: "FC" }] },
  });
  assert.equal(honest.status, 400);
  assert.equal(honest.body.error, "PRICE_TOO_LOW");
  await assertNothingChanged([product], [20]);
});

itest("17. a correction keeps the sale's historical rate whatever rate the client sends", async () => {
  const product = await fcPricedProduct();
  const created = await ctx.sell(
    [{ product, quantity: 5, price: 18000 / 2850, enteredPrice: 18000, enteredCurrency: "FC" }],
    { exchangeRate: 2850 }
  );
  await ctx.setRate(2900);
  const sale = await Sale.findById(created.body._id).lean();
  const corrected = await ctx.request("PUT", `/sales/${sale._id}`, {
    token: ctx.token("superadmin"),
    body: correctionBody(sale, [{ _id: sale.items[0]._id, productId: sale.items[0].productId, quantity: 6, price: 1, enteredPrice: 18000, enteredCurrency: "FC", exchangeRate: 100 }], { exchangeRate: 100 }),
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  const after = await Sale.findById(sale._id).lean();
  assert.equal(after.exchangeRate, 2850);
  assert.deepEqual([after.items[0].exchangeRate, after.items[0].priceFC, after.items[0].revenueFC], [2850, 18000, 108000]);
  assert.equal(after.items[0].priceUSD, 18000 / 2850);
  assert.equal((await Product.findById(product._id)).stock, 44);
});

itest("23. restoring the normal price lets a discounted sale be corrected below 5 pieces", async () => {
  const product = await ctx.product("CLOTHES", 10, 20, 20);
  const created = await ctx.sell([{ product, quantity: 5, price: 15 }]);
  const sale = await Sale.findById(created.body._id).lean();
  const line = { _id: sale.items[0]._id, productId: sale.items[0].productId, quantity: 4 };
  const refused = await ctx.request("PUT", `/sales/${sale._id}`, { token: ctx.token("superadmin"), body: correctionBody(sale, [{ ...line, price: 15, enteredPrice: 15, enteredCurrency: "USD" }]) });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "DISCOUNT_QUANTITY_REQUIRED");
  assert.equal(refused.body.itemIndex, 0);

  const restored = await ctx.request("PUT", `/sales/${sale._id}`, { token: ctx.token("superadmin"), body: correctionBody(sale, [{ ...line, price: 20, enteredPrice: 20, enteredCurrency: "USD" }]) });
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

itest("20, 25. legacy sales without discount or FC-revenue fields stay stable and correctable", async () => {
  const product = await ctx.product("CLOTHES", 5, 8, 20);
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
  await ctx.setRate(2900);

  const history = await ctx.request("GET", "/sales", { token: ctx.token("superadmin") });
  assert.equal(history.status, 200);
  assert.equal(history.body.summary.revenueFC, 20000, "not 7.02 x 2,850 = 20,007 and not today's 2,900");
  assert.equal((await ctx.balance("CLOTHES")).revenueFC, 20000);

  // Its below-list historical price is not reinterpreted as a new discount.
  const legacy = await Sale.findById(legacyId).lean();
  const corrected = await ctx.request("PUT", `/sales/${legacyId}`, {
    token: ctx.token("superadmin"),
    body: correctionBody(legacy, [{ _id: itemId, productId: product._id, quantity: 1, price: 20000 / 2850, enteredPrice: 20000, enteredCurrency: "FC" }]),
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  const after = (await Sale.findById(legacyId).lean()).items[0];
  assert.deepEqual([after.priceFC, after.exchangeRate, after.discountApplied, after.referenceUnitSellingPriceFC], [20000, 2850, false, 20000]);
});
