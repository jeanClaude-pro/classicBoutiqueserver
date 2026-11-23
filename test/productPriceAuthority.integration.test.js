// The Product's selling price is authoritative, and since the FC-only cutover
// it is a price in Congolese francs (FC): there is no second currency and no
// exchange rate. A product recorded before the cutover keeps its own FC
// snapshot until it is next saved; recorded sales keep their amounts.
const test = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, createIntegrationContext } = require("./helpers/integrationContext");
const Product = require("../models/Product");
const Sale = require("../models/Sale");
const { MAX_REJECTIONS } = require("../utils/discountProbeGuard");

const ctx = createIntegrationContext();
test.before(ctx.setup);
test.after(ctx.teardown);
test.beforeEach(ctx.reset);
const itest = (name, fn) => test(name, { skip: SKIP }, fn);

// Created through the real Product API, as the Products page does.
async function createProduct({ price, unitCost, stock = 100, mainCategory = "CLOTHES" }) {
  const response = await ctx.request("POST", "/products", {
    token: ctx.token("superadmin"),
    body: {
      name: `Produit-${price}-${unitCost}`, mainCategory, subcategory: "Robes", purchasedQuantity: stock, stock,
      priceEnteredAmount: price, priceEnteredCurrency: "FC",
      unitCostEnteredAmount: unitCost, unitCostEnteredCurrency: "FC",
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return Product.findById(response.body._id).lean();
}

const fcLine = (product, quantity, enteredPrice) => ({ product, quantity, enteredPrice, enteredCurrency: "FC" });
const savedItem = async (response) => (await Sale.findById(response.body._id).lean()).items[0];
const editProduct = (product, body) => ctx.request("PUT", `/products/${product._id}`, { token: ctx.token("superadmin"), body });

itest("a product is recorded in FC only and sells at exactly its FC price", async () => {
  const robe = await createProduct({ price: 20000, unitCost: 10000 });
  assert.deepEqual(
    [robe.currency, robe.price, robe.priceFC, robe.priceEnteredAmount, robe.priceEnteredCurrency, robe.priceExchangeRate],
    ["FC", 20000, 20000, 20000, "FC", undefined],
  );
  assert.deepEqual([robe.unitCost, robe.unitCostFC, robe.unitCostExchangeRate, robe.totalAcquisitionCost], [10000, 10000, undefined, 1000000]);

  const sale = await ctx.sell([fcLine(robe, 1, 20000)]);
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  const item = await savedItem(sale);
  assert.deepEqual([item.enteredPrice, item.priceFC, item.unitSellingPrice, item.revenue], [20000, 20000, 20000, 20000]);
  assert.deepEqual([item.referenceUnitSellingPriceFC, item.discountApplied, item.discountPerUnitFC], [20000, false, 0]);
  assert.deepEqual([item.unitAcquisitionCost, item.costOfGoodsSold, item.grossProfit], [10000, 10000, 10000]);
  assert.deepEqual([item.priceUSD, item.exchangeRate], [undefined, undefined]);
});

itest("the Product API refuses a price or cost entered in dollars and changes nothing", async () => {
  const before = await Product.countDocuments();
  const created = await ctx.request("POST", "/products", {
    token: ctx.token("superadmin"),
    body: { name: "Chemise $", mainCategory: "CLOTHES", subcategory: "Chemises", purchasedQuantity: 5, stock: 5, priceEnteredAmount: 20, priceEnteredCurrency: "USD", unitCostEnteredAmount: 8, unitCostEnteredCurrency: "FC" },
  });
  assert.equal(created.status, 400);
  assert.match(created.body.error, /FC/);
  assert.equal(await Product.countDocuments(), before);

  const robe = await createProduct({ price: 20000, unitCost: 10000 });
  const edited = await editProduct(robe, { unitCostEnteredAmount: 4, unitCostEnteredCurrency: "USD" });
  assert.equal(edited.status, 400);
  const stored = await Product.findById(robe._id).lean();
  assert.deepEqual([stored.price, stored.unitCost], [20000, 10000]);
});

itest("15-18. a discount is measured from the exact FC price, with 50% profit protection", async () => {
  // Cost 10,000 FC, normal 20,000 FC: half of the 10,000 FC profit is kept,
  // so the lowest discounted price is 15,000 FC.
  const robe = await createProduct({ price: 20000, unitCost: 10000 });
  const under5 = await ctx.sell([fcLine(robe, 4, 19000)]);
  assert.equal(under5.body.error, "DISCOUNT_QUANTITY_REQUIRED");

  const tooLow = await ctx.sell([fcLine(robe, 5, 14999)]);
  assert.equal(tooLow.status, 400);
  assert.equal(tooLow.body.error, "PRICE_TOO_LOW");
  assert.equal(tooLow.body.message, "Prix trop bas. Veuillez augmenter le prix.");
  assert.doesNotMatch(JSON.stringify(tooLow.body), /15000|10000|unitCost|minimum|floor/);

  const accepted = await ctx.sell([fcLine(robe, 5, 15000)]);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  const item = await savedItem(accepted);
  assert.deepEqual([item.enteredPrice, item.priceFC, item.referenceUnitSellingPriceFC, item.discountPerUnitFC, item.discountApplied], [15000, 15000, 20000, 5000, true]);
  assert.deepEqual([item.revenue, item.costOfGoodsSold, item.grossProfit], [75000, 50000, 25000]);
});

itest("10-12, 21-23. a price edit is the new normal price; recorded sales keep their amounts", async () => {
  const robe = await createProduct({ price: 20000, unitCost: 10000 });
  const old = await ctx.sell([fcLine(robe, 1, 20000)]);
  assert.equal(old.status, 201);
  const before = await Sale.find().lean();

  const edited = await editProduct(robe, { priceEnteredAmount: 22000, priceEnteredCurrency: "FC" });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual([edited.body.currency, edited.body.price, edited.body.priceFC, edited.body.priceEnteredAmount], ["FC", 22000, 22000, 22000]);

  const next = await ctx.sell([fcLine(robe, 1, 22000)]);
  assert.equal(next.status, 201, JSON.stringify(next.body));
  assert.equal((await savedItem(next)).referenceUnitSellingPriceFC, 22000);
  const oldPriceNow = await ctx.sell([fcLine(robe, 1, 20000)]);
  assert.equal(oldPriceNow.body.error, "DISCOUNT_QUANTITY_REQUIRED", "20,000 FC is now a discount");

  const after = await Sale.find({ _id: { $in: before.map((sale) => sale._id) } }).lean();
  assert.deepEqual(after, before, "the recorded sale is untouched");
  const history = await ctx.request("GET", "/sales?type=sale", { token: ctx.token("superadmin") });
  assert.deepEqual([history.body.summary.currency, history.body.summary.revenue], ["FC", 42000]);
});

itest("an edit that omits the price and cost keeps them", async () => {
  const robe = await createProduct({ price: 20000, unitCost: 10000 });
  const renamed = await editProduct(robe, { name: "Robe renommée", stock: 90 });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const stored = await Product.findById(robe._id).lean();
  assert.deepEqual([stored.name, stored.stock, stored.price, stored.unitCost, stored.totalAcquisitionCost], ["Robe renommée", 90, 20000, 10000, robe.totalAcquisitionCost]);
});

itest("a product priced in dollars before the cutover sells at its own FC snapshot and becomes FC when next saved", async () => {
  const robe = await ctx.product("CLOTHES", 10000, 20000, 10);
  // The record as the pre-cutover version kept it: $7.02 / $3.51 at 2,850 FC/USD,
  // with the FC amounts that were entered, and no currency marker.
  await Product.collection.updateOne({ _id: robe._id }, {
    $set: { price: 7.02, priceExchangeRate: 2850, unitCost: 3.51, unitCostExchangeRate: 2850, totalAcquisitionCost: 35.1 },
    $unset: { currency: 1, totalAcquisitionCostFC: 1 },
  });

  const listed = await ctx.request("GET", `/products/${robe._id}`, { token: ctx.token("superadmin") });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual([listed.body.currency, listed.body.price, listed.body.unitCost, listed.body.priceExchangeRate], ["FC", 20000, 10000, undefined]);

  const sale = await ctx.sell([fcLine(robe, 1, 20000)]);
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  const item = await savedItem(sale);
  assert.deepEqual([item.priceFC, item.discountApplied, item.unitAcquisitionCost, item.grossProfit], [20000, false, 10000, 10000]);

  const saved = await editProduct(robe, { name: "Robe convertie" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const stored = await Product.findById(robe._id).lean();
  assert.deepEqual(
    [stored.currency, stored.price, stored.priceFC, stored.unitCost, stored.priceExchangeRate, stored.unitCostExchangeRate, stored.stock],
    ["FC", 20000, 20000, 10000, undefined, undefined, 9],
  );
});

itest("inventory retail value is stock x FC selling price, converted products included", async () => {
  await createProduct({ price: 20000, unitCost: 10000, stock: 10 });
  const legacy = await ctx.product("CLOTHES", 10000, 20000, 10);
  await Product.collection.updateOne({ _id: legacy._id }, { $set: { price: 7.02, priceExchangeRate: 2850 }, $unset: { currency: 1 } });
  const report = await ctx.request("GET", "/analytics/summary", { token: ctx.token("superadmin") });
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.equal(report.body.data.inventoryValuation.CLOTHES.retailValue, 400000);
});

itest("price probing: after repeated refusals a reduced price is refused without depending on the floor", async () => {
  const product = await ctx.product("CLOTHES", 10000, 20000, 500);
  for (let attempt = 0; attempt < MAX_REJECTIONS; attempt += 1) {
    const refused = await ctx.sell([{ product, quantity: 5, price: 14000 }]);
    assert.equal(refused.body.error, "PRICE_TOO_LOW");
  }
  // A valid discount (15,000 FC is exactly the floor) and an invalid one get the same answer.
  for (const price of [15000, 11000]) {
    const limited = await ctx.sell([{ product, quantity: 5, price }]);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "DISCOUNT_ATTEMPTS_LIMITED");
    assert.doesNotMatch(JSON.stringify(limited.body), /\b(15000|10000)\b|unitCost|minimum|floor/);
  }
  // Selling at the normal price is never affected, and nothing was written by the refusals.
  const normal = await ctx.sell([{ product, quantity: 5, price: 20000 }]);
  assert.equal(normal.status, 201, JSON.stringify(normal.body));
  assert.equal(await Sale.countDocuments(), 1);
  // Roles that can already see costs are not limited.
  assert.equal((await ctx.sell([{ product, quantity: 5, price: 15000 }], { role: "manager" })).status, 201);
  assert.equal((await ctx.sell([{ product, quantity: 5, price: 15000 }], { role: "superadmin" })).status, 201);
});

// Business rule: the POS sells at the selling price defined on the Product.
// That price is never refused ("Prix trop bas"), whatever its margin; only a
// discount below it is limited. Profit = selling price - acquisition cost.
itest("the Product's own selling price is always accepted, even below its purchase cost", async () => {
  const clearance = await createProduct({ price: 8000, unitCost: 10000, stock: 10 });
  const sold = await ctx.sell([fcLine(clearance, 1, 8000)]);
  assert.equal(sold.status, 201, JSON.stringify(sold.body));
  const line = await savedItem(sold);
  assert.deepEqual([line.revenue, line.costOfGoodsSold, line.grossProfit], [8000, 10000, -2000]);

  const robe = await createProduct({ price: 20000, unitCost: 19000, stock: 10 });
  const normal = await ctx.sell([fcLine(robe, 1, 20000)]);
  assert.equal(normal.status, 201, JSON.stringify(normal.body));
  // A discount below such a price is still limited by the floor.
  const discounted = await ctx.sell([fcLine(robe, 5, 15000)]);
  assert.equal(discounted.body.error, "PRICE_TOO_LOW");
});

itest("the retired exchange-rate API answers 410 Gone", async () => {
  for (const [method, path] of [["GET", "/exchange-rates/current"], ["GET", "/exchange-rates"], ["POST", "/exchange-rates"]]) {
    const response = await ctx.request(method, path, { token: ctx.token("superadmin"), body: method === "POST" ? { rate: 2900 } : undefined });
    assert.equal(response.status, 410, `${method} ${path}`);
    assert.equal(response.body.error, "EXCHANGE_RATES_RETIRED");
  }
});
