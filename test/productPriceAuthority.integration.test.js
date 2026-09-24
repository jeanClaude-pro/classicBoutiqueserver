// The currency in which a Product's normal selling price was defined is
// authoritative. A rate change only converts the other currency for NEW
// transactions; the Product's authoritative amount and every recorded sale
// snapshot stay exactly as they were.
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
async function createProduct({ price, currency, unitCost, costCurrency = currency, rate, stock = 100, mainCategory = "CLOTHES" }) {
  await ctx.setRate(rate);
  const response = await ctx.request("POST", "/products", {
    token: ctx.token("superadmin"),
    body: {
      name: `${currency}-${price}`, mainCategory, subcategory: "Robes", purchasedQuantity: stock, stock,
      priceEnteredAmount: price, priceEnteredCurrency: currency, priceExchangeRate: rate,
      unitCostEnteredAmount: unitCost, unitCostEnteredCurrency: costCurrency, unitCostExchangeRate: rate,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return Product.findById(response.body._id).lean();
}

const fcLine = (product, quantity, enteredPrice) => ({ product, quantity, price: 1, enteredPrice, enteredCurrency: "FC" });
const usdLine = (product, quantity, enteredPrice) => ({ product, quantity, price: enteredPrice, enteredPrice, enteredCurrency: "USD" });
const savedItem = async (response) => (await Sale.findById(response.body._id).lean()).items[0];
const editProduct = (product, body) => ctx.request("PUT", `/products/${product._id}`, { token: ctx.token("superadmin"), body });

itest("1-5. an FC product (20,000 FC at 2,850) still sells at exactly 20,000 FC after the rate moves to 2,900", async () => {
  const robe = await createProduct({ price: 20000, currency: "FC", unitCost: 10000, rate: 2850 });
  assert.deepEqual([robe.priceEnteredAmount, robe.priceEnteredCurrency, robe.priceFC], [20000, "FC", 20000]);

  await ctx.setRate(2900);
  const stored = await Product.findById(robe._id).lean();
  assert.deepEqual([stored.priceEnteredAmount, stored.priceFC, stored.priceEnteredCurrency], [20000, 20000, "FC"], "the rate change does not touch the Product");

  // One piece at 20,000 FC: had the normal price become 20,351 FC this would
  // be a discount and be refused for a cart under 5 pieces.
  const sale = await ctx.sell([fcLine(robe, 1, 20000)], { exchangeRate: 2900 });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  const item = await savedItem(sale);
  assert.deepEqual([item.enteredPrice, item.priceFC, item.exchangeRate], [20000, 20000, 2900]);
  assert.equal(item.priceUSD, 20000 / 2900);
  assert.equal(item.unitSellingPrice, 6.9);
  assert.deepEqual([item.referenceUnitSellingPriceFC, item.discountApplied, item.discountPerUnitFC], [20000, false, 0]);
  assert.notEqual(item.referenceUnitSellingPriceFC, 20351);
});

itest("6-9. a USD product stays exactly $20; its FC equivalent is 58,000 at 2,900 and 59,000 at 2,950", async () => {
  const chemise = await createProduct({ price: 20, currency: "USD", unitCost: 8, rate: 2850 });
  assert.equal(chemise.priceFC, 57000);

  const at2900 = await ctx.sell([usdLine(chemise, 1, 20)], { exchangeRate: 2900 });
  assert.equal(at2900.status, 201, JSON.stringify(at2900.body));
  const first = await savedItem(at2900);
  assert.deepEqual([first.priceUSD, first.priceFC, first.referenceUnitSellingPrice, first.referenceUnitSellingPriceFC, first.discountApplied], [20, 58000, 20, 58000, false]);

  // Its exact FC equivalent is the normal price too, not a discount.
  const inFC = await ctx.sell([fcLine(chemise, 1, 58000)], { exchangeRate: 2900 });
  assert.equal(inFC.status, 201, JSON.stringify(inFC.body));

  const at2950 = await ctx.sell([usdLine(chemise, 1, 20)], { exchangeRate: 2950 });
  assert.equal(at2950.status, 201, JSON.stringify(at2950.body));
  assert.deepEqual([(await savedItem(at2950)).priceUSD, (await savedItem(at2950)).priceFC], [20, 59000]);
  assert.equal((await Product.findById(chemise._id).lean()).price, 20, "the Product still says $20");
});

itest("10-12, 21-23. recorded FC and USD sales keep their snapshots after a rate change and a Product price edit", async () => {
  const robe = await createProduct({ price: 20000, currency: "FC", unitCost: 10000, rate: 2850 });
  const chemise = await createProduct({ price: 20, currency: "USD", unitCost: 8, rate: 2850 });
  const oldFC = await ctx.sell([fcLine(robe, 1, 20000)], { exchangeRate: 2850 });
  const oldUSD = await ctx.sell([usdLine(chemise, 1, 20)], { exchangeRate: 2850 });
  assert.equal(oldFC.status, 201);
  assert.equal(oldUSD.status, 201);
  const before = await Sale.find().sort({ createdAt: 1 }).lean();

  await ctx.setRate(2900);
  const edited = await editProduct(robe, { priceEnteredAmount: 22000, priceEnteredCurrency: "FC", priceExchangeRate: 2900 });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual([edited.body.priceEnteredAmount, edited.body.priceFC, edited.body.priceEnteredCurrency], [22000, 22000, "FC"]);

  // The future: the new authoritative 22,000 FC is the normal price.
  const next = await ctx.sell([fcLine(robe, 1, 22000)], { exchangeRate: 2900 });
  assert.equal(next.status, 201, JSON.stringify(next.body));
  assert.equal((await savedItem(next)).referenceUnitSellingPriceFC, 22000);
  const oldPriceNow = await ctx.sell([fcLine(robe, 1, 20000)], { exchangeRate: 2900 });
  assert.equal(oldPriceNow.body.error, "DISCOUNT_QUANTITY_REQUIRED", "20,000 FC is now a discount");

  // The past: every stored snapshot is unchanged.
  const after = await Sale.find({ _id: { $in: before.map((sale) => sale._id) } }).sort({ createdAt: 1 }).lean();
  assert.deepEqual(after.map((sale) => sale.items), before.map((sale) => sale.items));
  assert.deepEqual(after.map((sale) => [sale.total, sale.totalRevenueFC, sale.exchangeRate]), before.map((sale) => [sale.total, sale.totalRevenueFC, sale.exchangeRate]));

  // Sales History reads the snapshots.
  const history = await ctx.request("GET", "/sales?type=sale", { token: ctx.token("superadmin") });
  assert.equal(history.status, 200);
  const byId = Object.fromEntries(history.body.data.map((sale) => [String(sale._id), sale]));
  assert.deepEqual([byId[oldFC.body._id].items[0].priceFC, byId[oldFC.body._id].exchangeRate], [20000, 2850]);
  assert.deepEqual([byId[oldUSD.body._id].items[0].priceUSD, byId[oldUSD.body._id].items[0].priceFC], [20, 57000]);
  // Reports: revenue in FC is the sum of recorded snapshots (20,000 + 57,000 + 22,000).
  assert.equal(history.body.summary.revenueFC, 99000);
  const report = await ctx.request("GET", "/analytics/summary", { token: ctx.token("superadmin") });
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.equal(report.body.data.categoryBreakdown.CLOTHES.revenueFC, 99000);
});

itest("13-14. switching the Product price FC -> USD and USD -> FC makes the new currency authoritative", async () => {
  const robe = await createProduct({ price: 20000, currency: "FC", unitCost: 10000, rate: 2850 });
  await ctx.setRate(2900);
  const toUSD = await editProduct(robe, { priceEnteredAmount: 7.59, priceEnteredCurrency: "USD", priceExchangeRate: 2900 });
  assert.equal(toUSD.status, 200, JSON.stringify(toUSD.body));
  assert.deepEqual([toUSD.body.priceEnteredCurrency, toUSD.body.price], ["USD", 7.59]);
  const inUSD = await ctx.sell([usdLine(robe, 1, 7.59)], { exchangeRate: 3000 });
  assert.equal(inUSD.status, 201, JSON.stringify(inUSD.body));
  assert.deepEqual([(await savedItem(inUSD)).referenceUnitSellingPrice, (await savedItem(inUSD)).referenceUnitSellingPriceFC], [7.59, 22770]);

  const toFC = await editProduct(robe, { priceEnteredAmount: 23000, priceEnteredCurrency: "FC", priceExchangeRate: 3000 });
  assert.equal(toFC.status, 200, JSON.stringify(toFC.body));
  const inFC = await ctx.sell([fcLine(robe, 1, 23000)], { exchangeRate: 3100 });
  assert.equal(inFC.status, 201, JSON.stringify(inFC.body));
  const item = await savedItem(inFC);
  assert.deepEqual([item.priceFC, item.referenceUnitSellingPriceFC, item.discountApplied], [23000, 23000, false]);
  assert.equal(item.priceUSD, 23000 / 3100);
});

itest("an edit that resubmits the same price and cost keeps their snapshots instead of re-deriving them at today's rate", async () => {
  const robe = await createProduct({ price: 20000, currency: "FC", unitCost: 10000, rate: 2850 });
  await ctx.setRate(2900);
  const resaved = await editProduct(robe, {
    name: "Robe renommée", stock: 90,
    priceEnteredAmount: 20000, priceEnteredCurrency: "FC", priceExchangeRate: 2900,
    unitCostEnteredAmount: 10000, unitCostEnteredCurrency: "FC", unitCostExchangeRate: 2900,
  });
  assert.equal(resaved.status, 200, JSON.stringify(resaved.body));
  const stored = await Product.findById(robe._id).lean();
  assert.equal(stored.name, "Robe renommée");
  assert.deepEqual([stored.price, stored.priceExchangeRate, stored.priceFC], [robe.price, 2850, 20000]);
  assert.deepEqual([stored.unitCost, stored.unitCostExchangeRate, stored.totalAcquisitionCost], [robe.unitCost, 2850, robe.totalAcquisitionCost]);

  // Omitting price and cost entirely (what the edit form now sends) keeps them too.
  const omitted = await editProduct(robe, { stock: 80 });
  assert.equal(omitted.status, 200, JSON.stringify(omitted.body));
  const again = await Product.findById(robe._id).lean();
  assert.deepEqual([again.priceEnteredAmount, again.priceEnteredCurrency, again.unitCost, again.stock], [20000, "FC", robe.unitCost, 80]);
});

itest("15, 17-18. an FC product's discount is measured from the exact 20,000 FC at today's rate, with 50% profit protection", async () => {
  // Cost 10,000 FC at 2,850 = $3.51. Normal price at 2,900 = $6.90.
  // Half the $3.39 profit must be kept: the floor is $5.21 = 15,109 FC at 2,900.
  const robe = await createProduct({ price: 20000, currency: "FC", unitCost: 10000, rate: 2850 });
  const under5 = await ctx.sell([fcLine(robe, 4, 19000)], { exchangeRate: 2900 });
  assert.equal(under5.body.error, "DISCOUNT_QUANTITY_REQUIRED");

  const tooLow = await ctx.sell([fcLine(robe, 5, 15100)], { exchangeRate: 2900 });
  assert.equal(tooLow.status, 400);
  assert.equal(tooLow.body.error, "PRICE_TOO_LOW");
  assert.equal(tooLow.body.message, "Prix trop bas. Veuillez augmenter le prix.");
  assert.doesNotMatch(JSON.stringify(tooLow.body), /15109|5\.21|3\.51|unitCost|minimum|floor/);

  const accepted = await ctx.sell([fcLine(robe, 5, 15200)], { exchangeRate: 2900 });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  const item = await savedItem(accepted);
  assert.deepEqual([item.enteredPrice, item.priceFC, item.referenceUnitSellingPriceFC, item.discountPerUnitFC, item.discountApplied], [15200, 15200, 20000, 4800, true]);
  assert.equal(item.referenceUnitSellingPrice, 6.9);
});

itest("16-18. a USD product's discount is measured from the exact $20, whatever the rate", async () => {
  // Cost $8, normal $20: the floor keeps half the $12 profit, i.e. $14.
  const chemise = await createProduct({ price: 20, currency: "USD", unitCost: 8, rate: 2850 });
  assert.equal((await ctx.sell([usdLine(chemise, 5, 13.99)], { exchangeRate: 2900 })).body.error, "PRICE_TOO_LOW");
  assert.equal((await ctx.sell([fcLine(chemise, 5, 40599)], { exchangeRate: 2900 })).body.error, "PRICE_TOO_LOW");
  const inFC = await ctx.sell([fcLine(chemise, 5, 40600)], { exchangeRate: 2900 });
  assert.equal(inFC.status, 201, JSON.stringify(inFC.body));
  assert.deepEqual([(await savedItem(inFC)).referenceUnitSellingPriceFC, (await savedItem(inFC)).discountPerUnitFC], [58000, 17400]);
  const inUSD = await ctx.sell([usdLine(chemise, 5, 14)], { exchangeRate: 2900 });
  assert.equal(inUSD.status, 201, JSON.stringify(inUSD.body));
  assert.deepEqual([(await savedItem(inUSD)).referenceUnitSellingPrice, (await savedItem(inUSD)).discountPerUnit], [20, 6]);
});

itest("19-20. EXCHANGE_RATE_CHANGED: after a refusal the same 20,000 FC and $20 are accepted at the new rate", async () => {
  const robe = await createProduct({ price: 20000, currency: "FC", unitCost: 10000, rate: 2850 });
  const chemise = await createProduct({ price: 20, currency: "USD", unitCost: 8, rate: 2850 });
  await ctx.setRate(2900);
  const body = (rate) => ({
    isWalkIn: true, paymentMethod: "cash", exchangeRate: rate,
    items: [
      { productId: String(robe._id), quantity: 1, price: 20000 / rate, enteredPrice: 20000, enteredCurrency: "FC", exchangeRate: rate },
      { productId: String(chemise._id), quantity: 1, price: 20, enteredPrice: 20, enteredCurrency: "USD", exchangeRate: rate },
    ],
  });
  const stale = await ctx.request("POST", "/sales", { token: ctx.token("staff"), body: body(2850) });
  assert.equal(stale.status, 409);
  assert.deepEqual([stale.body.error, stale.body.exchangeRate], ["EXCHANGE_RATE_CHANGED", 2900]);
  assert.equal(await Sale.countDocuments(), 0);

  const retried = await ctx.request("POST", "/sales", { token: ctx.token("staff"), body: body(2900) });
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const items = (await Sale.findById(retried.body._id).lean()).items;
  assert.deepEqual([items[0].enteredPrice, items[0].priceFC, items[0].discountApplied], [20000, 20000, false]);
  assert.deepEqual([items[1].priceUSD, items[1].priceFC, items[1].discountApplied], [20, 58000, false]);
});

itest("inventory retail value prices FC-defined stock at today's rate and USD-defined stock at its USD price", async () => {
  await createProduct({ price: 20000, currency: "FC", unitCost: 10000, rate: 2850, stock: 10 });
  await createProduct({ price: 20, currency: "USD", unitCost: 8, rate: 2850, stock: 10 });
  await ctx.setRate(2900);
  const report = await ctx.request("GET", "/analytics/summary", { token: ctx.token("superadmin") });
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.ok(Math.abs(report.body.data.inventoryValuation.CLOTHES.retailValue - (10 * 20000 / 2900 + 10 * 20)) < 1e-9);
});

itest("price probing: after repeated refusals a reduced price is refused without depending on the floor", async () => {
  const product = await ctx.product("CLOTHES", 10, 20, 500);
  await ctx.setRate(2850);
  for (let attempt = 0; attempt < MAX_REJECTIONS; attempt += 1) {
    const refused = await ctx.sell([{ product, quantity: 5, price: 14 }]);
    assert.equal(refused.body.error, "PRICE_TOO_LOW");
  }
  // A valid discount ($15 is exactly the floor) and an invalid one get the same answer.
  for (const price of [15, 11]) {
    const limited = await ctx.sell([{ product, quantity: 5, price }]);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "DISCOUNT_ATTEMPTS_LIMITED");
    assert.doesNotMatch(JSON.stringify(limited.body), /\b(15|10)\b|unitCost|minimum|floor/);
  }
  // Selling at the normal price is never affected, and nothing was written by the refusals.
  const normal = await ctx.sell([{ product, quantity: 5, price: 20 }]);
  assert.equal(normal.status, 201, JSON.stringify(normal.body));
  assert.equal(await Sale.countDocuments(), 1);
  // Another cashier, and roles that can already see costs, are not limited.
  assert.equal((await ctx.sell([{ product, quantity: 5, price: 15 }], { role: "manager" })).status, 201);
  assert.equal((await ctx.sell([{ product, quantity: 5, price: 15 }], { role: "superadmin" })).status, 201);
});
