const test = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, createIntegrationContext } = require("./helpers/integrationContext");
const Product = require("../models/Product");
const Sale = require("../models/Sale");
const ExchangeRate = require("../models/ExchangeRate");

const ctx = createIntegrationContext();
test.before(ctx.setup);
test.after(ctx.teardown);
test.beforeEach(ctx.reset);
const itest = (name, fn) => test(name, { skip: SKIP }, fn);

itest("discount rejection happens before stock or sale mutation", async () => {
  const product = await ctx.product("CLOTHES", 10, 20, 20);
  const rejected = await ctx.sell([{ product, quantity: 4, price: 15 }]);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, "DISCOUNT_QUANTITY_REQUIRED");
  assert.equal((await Product.findById(product._id)).stock, 20);
  assert.equal(await Sale.countDocuments(), 0);
});

itest("five units of one product accept the exact boundary and persist actual financial snapshots", async () => {
  const product = await ctx.product("CLOTHES", 10, 20, 20);
  const response = await ctx.sell([{ product, quantity: 5, price: 15 }]);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.items[0].unitAcquisitionCost, undefined, "ordinary sale responses hide acquisition cost");
  assert.equal(response.body.items[0].grossProfit, undefined, "ordinary sale responses hide protected margin");
  const sale = await Sale.findById(response.body._id).lean();
  assert.deepEqual(
    [sale.total, sale.costOfGoodsSold, sale.grossProfit, sale.clothesShareholderProfit],
    [75, 50, 25, 25]
  );
  assert.deepEqual(
    [sale.items[0].referenceUnitSellingPrice, sale.items[0].discountApplied, sale.items[0].discountPerUnit],
    [20, true, 5]
  );
  assert.equal((await Product.findById(product._id)).stock, 15);
});

itest("five distinct products and mixed quantities both qualify", async () => {
  const products = await Promise.all(Array.from({ length: 5 }, () => ctx.product("CLOTHES", 10, 20, 10)));
  const distinct = await ctx.sell(products.map((product) => ({ product, quantity: 1, price: 15 })));
  assert.equal(distinct.status, 201, JSON.stringify(distinct.body));

  const a = await ctx.product("SHOES", 10, 20, 10);
  const b = await ctx.product("SHOES", 10, 20, 10);
  const mixed = await ctx.sell([{ product: a, quantity: 3, price: 15 }, { product: b, quantity: 2, price: 15 }]);
  assert.equal(mixed.status, 201, JSON.stringify(mixed.body));
});

itest("exact FC discount and historical exchange-rate snapshots survive persistence", async () => {
  const product = await ctx.product("CLOTHES", 10000 / 2850, 20000 / 2850, 20);
  const response = await ctx.sell(
    [{ product, quantity: 5, price: 18000 / 2850, enteredPrice: 18000, enteredCurrency: "FC" }],
    { exchangeRate: 2850 }
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const sale = await Sale.findById(response.body._id).lean();
  assert.equal(sale.exchangeRate, 2850);
  assert.equal(sale.items[0].enteredPrice, 18000);
  assert.equal(sale.items[0].priceFC, 18000);
  assert.equal(sale.items[0].priceUSD, 18000 / 2850);
  assert.equal(sale.items[0].exchangeRate, 2850);

  await ExchangeRate.create({
    rate: 2900,
    createdBy: ctx.users.superadmin.user._id,
    isActive: true,
  });
  const history = await ctx.request("GET", "/sales?type=sale", { token: ctx.token("superadmin") });
  assert.equal(history.status, 200);
  assert.equal(history.body.summary.revenueFC, 90000);
  assert.equal(history.body.data[0].items[0].priceFC, 18000);
  assert.equal(history.body.data[0].exchangeRate, 2850);
});

itest("a correction from five discounted units to four is rejected without changing stock", async () => {
  const product = await ctx.product("CLOTHES", 10, 20, 20);
  const created = await ctx.sell([{ product, quantity: 5, price: 15 }]);
  const sale = await Sale.findById(created.body._id).lean();
  const corrected = await ctx.request("PUT", `/sales/${sale._id}`, {
    token: ctx.token("superadmin"),
    body: {
      isWalkIn: true,
      customer: sale.customer,
      paymentMethod: sale.paymentMethod,
      reason: "quantity correction",
      exchangeRate: sale.exchangeRate,
      items: sale.items.map((item) => ({
        _id: item._id,
        productId: item.productId,
        name: item.name,
        quantity: 4,
        price: item.price,
        enteredPrice: item.enteredPrice,
        enteredCurrency: item.enteredCurrency,
        exchangeRate: item.exchangeRate,
      })),
    },
  });
  assert.equal(corrected.status, 400);
  assert.equal(corrected.body.error, "DISCOUNT_QUANTITY_REQUIRED");
  assert.equal((await Product.findById(product._id)).stock, 15);
  assert.equal((await Sale.findById(sale._id)).items[0].quantity, 5);
});

