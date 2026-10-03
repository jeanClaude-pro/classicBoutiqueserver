// Individual Fiche de stock, inventory valuation at selling price, and the
// products-sold financial identities:
//   inventory value  = closing quantity x CURRENT selling price (unsold stock)
//   profit           = actual selling amount - purchase cost (sale snapshots)
//   revenue          = purchase cost + profit = actual selling amount
const test = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, createIntegrationContext } = require("./helpers/integrationContext");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const { currentBusinessDate } = require("../utils/queryHelpers");

const ctx = createIntegrationContext();
test.before(ctx.setup);
test.after(ctx.teardown);
test.beforeEach(ctx.reset);
const itest = (name, fn) => test(name, { skip: SKIP }, fn);

const RATE = 2850;
let counter = 0;
async function createProduct({ price, currency = "USD", unitCost, stock, mainCategory = "CLOTHES", name }) {
  await ctx.setRate(RATE);
  counter += 1;
  const response = await ctx.request("POST", "/products", {
    token: ctx.token("superadmin"),
    body: {
      name: name || `Produit ${counter}`, mainCategory, subcategory: "Test", purchasedQuantity: stock, stock,
      priceEnteredAmount: price, priceEnteredCurrency: currency, priceExchangeRate: RATE,
      unitCostEnteredAmount: unitCost, unitCostEnteredCurrency: currency, unitCostExchangeRate: RATE,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return Product.findById(response.body._id).lean();
}
const today = () => currentBusinessDate();
const todayQuery = () => `from=${today()}&to=${today()}`;
const productSheet = (product, role = "superadmin", query = todayQuery()) =>
  ctx.request("GET", `/products/${product._id}/stock-sheet?${query}`, { token: ctx.token(role) });
const salesSheet = (role = "superadmin", query = todayQuery()) =>
  ctx.request("GET", `/analytics/sales-sheet?${query}`, { token: ctx.token(role) });
const sell = (lines, extra = {}) => ctx.sell(lines.map(([product, quantity, price]) => ({ product, quantity, price })), { exchangeRate: RATE, ...extra });
const cents = (value) => Math.round(value * 100);

// ------------------------------------------------------ individual Fiche de stock

itest("each product's fiche reports that product only, reconciled and valued at its selling price", async () => {
  const a = await createProduct({ name: "Chemise Classic", price: 20, unitCost: 10, stock: 10 });
  const b = await createProduct({ name: "Nike Air", price: 50, unitCost: 30, stock: 8, mainCategory: "SHOES" });
  assert.equal((await ctx.request("PUT", `/products/${a._id}`, { token: ctx.token("superadmin"), body: { stock: 16 } })).status, 200);
  assert.equal((await ctx.request("PUT", `/products/${a._id}`, { token: ctx.token("superadmin"), body: { stock: 15 } })).status, 200);
  const sold = await sell([[await Product.findById(a._id), 3, 20]]);
  assert.equal(sold.status, 201, JSON.stringify(sold.body));
  await ctx.request("PATCH", `/sales/${sold.body._id}/void`, { token: ctx.token("superadmin"), body: { reason: "test" } });
  assert.equal((await sell([[await Product.findById(a._id), 2, 20]])).status, 201);
  await sell([[await Product.findById(b._id), 1, 50]]);

  const sheetA = await productSheet(a);
  assert.equal(sheetA.status, 200, JSON.stringify(sheetA.body));
  assert.equal(sheetA.body.product.productId, String(a._id));
  assert.equal(sheetA.body.product.name, "Chemise Classic");
  assert.deepEqual([sheetA.body.product.category, sheetA.body.product.unit, sheetA.body.product.currentStock, sheetA.body.product.status], ["CLOTHES", "pcs", 13, "active"]);
  const row = sheetA.body.row;
  assert.deepEqual([row.openingStock, row.additions, row.reductions, row.salesOut, row.closingStock], [0, 16, 1, 2, 13]);
  assert.equal(row.openingStock + row.additions - row.reductions - row.salesOut, row.closingStock);
  // 13 pieces x $20 = $260 (FC: 13 x 57,000 = 741,000).
  assert.deepEqual(row.sellingPrice, { currency: "USD", usd: 20, fc: 57000 });
  assert.deepEqual(row.inventoryValue, { usd: 260, fc: 741000 });

  const sheetB = await productSheet(b);
  assert.equal(sheetB.body.product.name, "Nike Air");
  assert.deepEqual([sheetB.body.row.openingStock, sheetB.body.row.salesOut, sheetB.body.row.closingStock], [0, 1, 7]);
  assert.deepEqual(sheetB.body.row.inventoryValue, { usd: 350, fc: 7 * 142500 });
});

itest("an FC-defined product is valued exactly in FC at its current price", async () => {
  const robe = await createProduct({ name: "Robe FC", price: 20000, currency: "FC", unitCost: 10000, stock: 7 });
  const response = await productSheet(robe);
  assert.deepEqual(response.body.row.sellingPrice, { currency: "FC", usd: 7.02, fc: 20000 });
  assert.deepEqual(response.body.row.inventoryValue, { fc: 140000, usd: 49.12 });
  // Valuation follows today's selling price, never a sale price, and is read-only.
  await ctx.request("PUT", `/products/${robe._id}`, { token: ctx.token("superadmin"), body: { priceEnteredAmount: 25000, priceEnteredCurrency: "FC", priceExchangeRate: RATE } });
  const repriced = await productSheet(robe);
  assert.equal(repriced.body.row.inventoryValue.fc, 175000);
  const stored = await Product.findById(robe._id).lean();
  assert.equal(stored.priceEnteredAmount, 25000);
});

itest("the individual fiche enforces category authorization, ids and the selected period", async () => {
  const shoes = await createProduct({ price: 50, unitCost: 30, stock: 4, mainCategory: "SHOES" });
  assert.equal((await productSheet(shoes, "clothesShareholder")).status, 403);
  assert.equal((await productSheet(shoes, "shoesShareholder")).status, 200);
  assert.equal((await ctx.request("GET", `/products/not-an-id/stock-sheet?${todayQuery()}`, { token: ctx.token("superadmin") })).status, 400);
  assert.equal((await ctx.request("GET", `/products/64b000000000000000000000/stock-sheet?${todayQuery()}`, { token: ctx.token("superadmin") })).status, 404);
  // The product did not exist yet during a past period.
  const past = await productSheet(shoes, "superadmin", "from=2020-01-01&to=2020-01-31");
  assert.equal(past.status, 200);
  assert.equal(past.body.row, null);
  assert.equal(past.body.period.start, "2019-12-31T22:00:00.000Z");
});

itest("the global stock sheet carries per-product valuation and respects category pinning", async () => {
  await createProduct({ name: "A", price: 20, unitCost: 10, stock: 3 });
  await createProduct({ name: "B", price: 20000, currency: "FC", unitCost: 9000, stock: 2 });
  await createProduct({ name: "S", price: 50, unitCost: 30, stock: 1, mainCategory: "SHOES" });
  const all = await ctx.request("GET", `/products/stock-sheet?${todayQuery()}`, { token: ctx.token("superadmin") });
  assert.deepEqual(all.body.rows.map((row) => [row.product, row.inventoryValue.fc]), [["A", 171000], ["B", 40000], ["S", 142500]]);
  assert.deepEqual(all.body.totals.inventoryValue, { usd: 124.04, fc: 171000 + 40000 + 142500 });
  const clothes = await ctx.request("GET", `/products/stock-sheet?${todayQuery()}&category=SHOES`, { token: ctx.token("clothesShareholder") });
  assert.deepEqual(clothes.body.rows.map((row) => row.product), ["A", "B"]);
});

// ------------------------------------------------------ products sold financials

itest("profit = selling amount - purchase cost and revenue = purchase cost + profit, per product and in total", async () => {
  const shirt = await createProduct({ name: "Chemise", price: 20, unitCost: 10, stock: 20 });
  const tie = await createProduct({ name: "Cravate", price: 20, unitCost: 10, stock: 20 });
  // 4 shirts at the discounted $15 + 1 tie at $20 = a 5-piece cart.
  const sale = await sell([[shirt, 4, 15], [tie, 1, 20]]);
  assert.equal(sale.status, 201, JSON.stringify(sale.body));

  const response = await salesSheet();
  assert.equal(response.body.financialsVisible, true);
  const row = response.body.rows.find((item) => item.product === "Chemise");
  // Purchase cost 4 x $10 = $40, revenue 4 x $15 = $60, profit $60 - $40 = $20.
  assert.deepEqual([row.quantitySold, row.purchaseCost.usd, row.revenue.usd, row.profit.usd], [4, 40, 60, 20]);
  assert.equal(cents(row.revenue.usd), cents(row.purchaseCost.usd) + cents(row.profit.usd));
  assert.equal(row.revenue.fc, row.purchaseCost.fc + row.profit.fc);
  assert.deepEqual([row.purchaseCost.fc, row.revenue.fc, row.profit.fc], [114000, 171000, 57000]);

  const { summary } = response.body;
  assert.deepEqual([summary.unitsSold, summary.purchaseCost.usd, summary.revenue.usd, summary.profit.usd], [5, 50, 80, 30]);
  assert.equal(cents(summary.revenue.usd), cents(summary.purchaseCost.usd) + cents(summary.profit.usd));
  assert.equal(summary.revenue.fc, summary.purchaseCost.fc + summary.profit.fc);
});

// The protected-profit floor keeps half the normal margin: with cost $10 and
// normal price $20 the lowest family price is $15 (a $14 request is refused).
itest("a family sale is reported at its actual discounted price, and old costs stay historical", async () => {
  const product = await createProduct({ name: "Veste", price: 20, unitCost: 10, stock: 5 });
  const member = await Customer.create({ name: "Famille", phone: "0991001000", isFamilyMember: true });
  const response = await ctx.request("POST", "/sales", {
    token: ctx.token("superadmin"),
    body: {
      isFamilySale: true, familyMemberId: String(member._id), isWalkIn: false, customer: { name: "Famille", phone: "0991001000" },
      exchangeRate: RATE, paymentMethod: "cash", requestKey: "family-report-1",
      items: [{ productId: String(product._id), quantity: 1, price: 16, enteredPrice: 16, enteredCurrency: "USD", exchangeRate: RATE }],
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  // Today's purchase cost changes later; the report keeps the sale's snapshot.
  await ctx.request("PUT", `/products/${product._id}`, { token: ctx.token("superadmin"), body: { unitCostEnteredAmount: 12, unitCostEnteredCurrency: "USD", unitCostExchangeRate: RATE } });
  const row = (await salesSheet()).body.rows.find((item) => item.product === "Veste");
  // Family price $16 (normal $20, cost $10): revenue $16, profit $16 - $10 = $6.
  assert.deepEqual([row.quantitySold, row.revenue.usd, row.purchaseCost.usd, row.profit.usd], [1, 16, 10, 6]);
});

itest("FC-defined products keep exact FC amounts in the products-sold totals", async () => {
  const robe = await createProduct({ name: "Robe", price: 20000, currency: "FC", unitCost: 10000, stock: 10 });
  const sale = await ctx.sell([{ product: robe, quantity: 2, price: 20000 / RATE, enteredPrice: 20000, enteredCurrency: "FC" }], { exchangeRate: RATE });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  const row = (await salesSheet()).body.rows.find((item) => item.product === "Robe");
  assert.deepEqual([row.revenue.fc, row.purchaseCost.fc, row.profit.fc], [40000, 20000, 20000]);
  assert.equal(cents(row.revenue.usd), cents(row.purchaseCost.usd) + cents(row.profit.usd));
});

itest("purchase cost and profit are only returned to the superadmin and shareholders, per category", async () => {
  const clothes = await createProduct({ name: "C", price: 20, unitCost: 10, stock: 10 });
  const shoes = await createProduct({ name: "S", price: 50, unitCost: 30, stock: 10, mainCategory: "SHOES" });
  await sell([[clothes, 1, 20], [shoes, 1, 50]]);
  const manager = await salesSheet("reportsManager");
  assert.equal(manager.status, 200);
  assert.equal(manager.body.financialsVisible, false);
  assert.ok(manager.body.rows.every((row) => row.purchaseCost === undefined && row.profit === undefined));
  assert.equal(manager.body.summary.profit, undefined);
  assert.doesNotMatch(JSON.stringify(manager.body), /purchaseCost|profit/i);

  const shareholder = await salesSheet("shoesShareholder", `${todayQuery()}&category=CLOTHES`);
  assert.equal(shareholder.body.category, "SHOES");
  assert.deepEqual(shareholder.body.rows.map((row) => [row.product, row.profit.usd]), [["S", 20]]);
});

itest("the sales sheet lists, per product, each price it was sold at and the pieces that left at that price", async () => {
  const shirt = await createProduct({ name: "Chemise", price: 20, unitCost: 10, stock: 20 });
  const tie = await createProduct({ name: "Cravate", price: 20, unitCost: 10, stock: 20 });
  const robe = await createProduct({ name: "Robe", price: 20000, currency: "FC", unitCost: 10000, stock: 10 });
  assert.equal((await sell([[shirt, 4, 15], [tie, 1, 20]])).status, 201); // 4 shirts at the discounted $15
  assert.equal((await sell([[shirt, 1, 20]])).status, 201); // 1 shirt at its normal $20
  const fcSale = await ctx.sell([{ product: robe, quantity: 2, price: 20000 / RATE, enteredPrice: 20000, enteredCurrency: "FC" }], { exchangeRate: RATE });
  assert.equal(fcSale.status, 201, JSON.stringify(fcSale.body));

  const { body } = await salesSheet();
  const row = (name) => body.rows.find((item) => item.product === name);
  assert.equal(row("Chemise").quantitySold, 5);
  assert.deepEqual(row("Chemise").prices.map((price) => [price.currency, price.unitPrice.usd, price.quantity, price.revenue.usd]), [
    ["USD", 20, 1, 20],
    ["USD", 15, 4, 60],
  ]);
  assert.deepEqual(row("Chemise").revenue, { usd: 80, fc: 228000 }, "revenue = sum of price x pieces");
  assert.deepEqual(row("Robe").prices.map((price) => [price.currency, price.unitPrice.fc, price.quantity, price.revenue.fc]), [["FC", 20000, 2, 40000]]);
  assert.equal(body.summary.unitsSold, 8);

  // Without financial access the price and pieces are still shown.
  const manager = await salesSheet("reportsManager");
  assert.deepEqual(manager.body.rows.find((item) => item.product === "Chemise").prices.map((price) => price.quantity), [1, 4]);
});
