// Individual Fiche de stock, inventory valuation at selling price, and the
// products-sold financial identities:
//   inventory value  = closing quantity x CURRENT selling price (unsold stock)
//   profit           = actual selling amount - purchase cost (sale snapshots)
//   revenue          = purchase cost + profit = actual selling amount
// Every amount is in Congolese francs (FC), as { fc } money objects.
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

let counter = 0;
async function createProduct({ price, unitCost, stock, mainCategory = "CLOTHES", name }) {
  counter += 1;
  const response = await ctx.request("POST", "/products", {
    token: ctx.token("superadmin"),
    body: {
      name: name || `Produit ${counter}`, mainCategory, subcategory: "Test", purchasedQuantity: stock, stock,
      priceEnteredAmount: price, priceEnteredCurrency: "FC",
      unitCostEnteredAmount: unitCost, unitCostEnteredCurrency: "FC",
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
const sell = (lines, extra = {}) => ctx.sell(lines.map(([product, quantity, price]) => ({ product, quantity, price })), extra);
const cents = (value) => Math.round(value * 100);

// ------------------------------------------------------ individual Fiche de stock

itest("each product's fiche reports that product only, reconciled and valued at its selling price", async () => {
  const a = await createProduct({ name: "Chemise Classic", price: 20000, unitCost: 10000, stock: 10 });
  const b = await createProduct({ name: "Nike Air", price: 50000, unitCost: 30000, stock: 8, mainCategory: "SHOES" });
  assert.equal((await ctx.request("PUT", `/products/${a._id}`, { token: ctx.token("superadmin"), body: { stock: 16 } })).status, 200);
  assert.equal((await ctx.request("PUT", `/products/${a._id}`, { token: ctx.token("superadmin"), body: { stock: 15 } })).status, 200);
  const sold = await sell([[await Product.findById(a._id), 3, 20000]]);
  assert.equal(sold.status, 201, JSON.stringify(sold.body));
  await ctx.request("PATCH", `/sales/${sold.body._id}/void`, { token: ctx.token("superadmin"), body: { reason: "test" } });
  assert.equal((await sell([[await Product.findById(a._id), 2, 20000]])).status, 201);
  await sell([[await Product.findById(b._id), 1, 50000]]);

  const sheetA = await productSheet(a);
  assert.equal(sheetA.status, 200, JSON.stringify(sheetA.body));
  assert.equal(sheetA.body.product.productId, String(a._id));
  assert.equal(sheetA.body.product.name, "Chemise Classic");
  assert.deepEqual([sheetA.body.product.category, sheetA.body.product.unit, sheetA.body.product.currentStock, sheetA.body.product.status], ["CLOTHES", "pcs", 13, "active"]);
  const row = sheetA.body.row;
  assert.deepEqual([row.openingStock, row.additions, row.reductions, row.salesOut, row.closingStock], [0, 16, 1, 2, 13]);
  assert.equal(row.openingStock + row.additions - row.reductions - row.salesOut, row.closingStock);
  // 13 pieces x 20,000 FC = 260,000 FC.
  assert.deepEqual(row.sellingPrice, { currency: "FC", fc: 20000 });
  assert.deepEqual(row.inventoryValue, { fc: 260000 });

  const sheetB = await productSheet(b);
  assert.equal(sheetB.body.product.name, "Nike Air");
  assert.deepEqual([sheetB.body.row.openingStock, sheetB.body.row.salesOut, sheetB.body.row.closingStock], [0, 1, 7]);
  assert.deepEqual(sheetB.body.row.inventoryValue, { fc: 350000 });
});

itest("valuation follows today's FC selling price, never a sale price, and is read-only", async () => {
  const robe = await createProduct({ name: "Robe", price: 20000, unitCost: 10000, stock: 7 });
  const response = await productSheet(robe);
  assert.deepEqual(response.body.row.sellingPrice, { currency: "FC", fc: 20000 });
  assert.deepEqual(response.body.row.inventoryValue, { fc: 140000 });
  await ctx.request("PUT", `/products/${robe._id}`, { token: ctx.token("superadmin"), body: { priceEnteredAmount: 25000, priceEnteredCurrency: "FC" } });
  const repriced = await productSheet(robe);
  assert.equal(repriced.body.row.inventoryValue.fc, 175000);
  const stored = await Product.findById(robe._id).lean();
  assert.deepEqual([stored.currency, stored.price, stored.priceEnteredAmount, stored.priceExchangeRate], ["FC", 25000, 25000, undefined]);
});

itest("the individual fiche enforces category authorization, ids and the selected period", async () => {
  const shoes = await createProduct({ price: 50000, unitCost: 30000, stock: 4, mainCategory: "SHOES" });
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
  await createProduct({ name: "A", price: 57000, unitCost: 28500, stock: 3 });
  await createProduct({ name: "B", price: 20000, unitCost: 9000, stock: 2 });
  await createProduct({ name: "S", price: 142500, unitCost: 85500, stock: 1, mainCategory: "SHOES" });
  const all = await ctx.request("GET", `/products/stock-sheet?${todayQuery()}`, { token: ctx.token("superadmin") });
  assert.equal(all.body.currency, "FC");
  assert.deepEqual(all.body.rows.map((row) => [row.product, row.inventoryValue.fc]), [["A", 171000], ["B", 40000], ["S", 142500]]);
  assert.deepEqual(all.body.totals.inventoryValue, { fc: 171000 + 40000 + 142500 });
  const clothes = await ctx.request("GET", `/products/stock-sheet?${todayQuery()}&category=SHOES`, { token: ctx.token("clothesShareholder") });
  assert.deepEqual(clothes.body.rows.map((row) => row.product), ["A", "B"]);
});

// ------------------------------------------------------ products sold financials

itest("profit = selling amount - purchase cost and revenue = purchase cost + profit, per product and in total", async () => {
  const shirt = await createProduct({ name: "Chemise", price: 20000, unitCost: 10000, stock: 20 });
  const tie = await createProduct({ name: "Cravate", price: 20000, unitCost: 10000, stock: 20 });
  // 4 shirts at the discounted 15,000 FC + 1 tie at 20,000 FC = a 5-piece cart.
  const sale = await sell([[shirt, 4, 15000], [tie, 1, 20000]]);
  assert.equal(sale.status, 201, JSON.stringify(sale.body));

  const response = await salesSheet();
  assert.equal(response.body.financialsVisible, true);
  assert.equal(response.body.currency, "FC");
  const row = response.body.rows.find((item) => item.product === "Chemise");
  // Purchase cost 4 x 10,000 = 40,000, revenue 4 x 15,000 = 60,000, profit 20,000.
  assert.deepEqual([row.quantitySold, row.purchaseCost, row.revenue, row.profit], [4, { fc: 40000 }, { fc: 60000 }, { fc: 20000 }]);
  assert.equal(cents(row.revenue.fc), cents(row.purchaseCost.fc) + cents(row.profit.fc));

  const { summary } = response.body;
  assert.deepEqual([summary.unitsSold, summary.purchaseCost, summary.revenue, summary.profit], [5, { fc: 50000 }, { fc: 80000 }, { fc: 30000 }]);
  assert.equal(cents(summary.revenue.fc), cents(summary.purchaseCost.fc) + cents(summary.profit.fc));
});

// The protected-profit floor keeps half the normal margin: with cost 10,000
// and normal price 20,000 FC the lowest family price is 15,000 FC.
itest("a family sale is reported at its actual discounted price, and old costs stay historical", async () => {
  const product = await createProduct({ name: "Veste", price: 20000, unitCost: 10000, stock: 5 });
  const member = await Customer.create({ name: "Famille", phone: "0991001000", isFamilyMember: true });
  const response = await ctx.request("POST", "/sales", {
    token: ctx.token("superadmin"),
    body: {
      isFamilySale: true, familyMemberId: String(member._id), isWalkIn: false, customer: { name: "Famille", phone: "0991001000" },
      currency: "FC", paymentMethod: "cash", requestKey: "family-report-1",
      items: [{ productId: String(product._id), quantity: 1, price: 16000, enteredPrice: 16000, enteredCurrency: "FC" }],
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  // Today's purchase cost changes later; the report keeps the sale's snapshot.
  await ctx.request("PUT", `/products/${product._id}`, { token: ctx.token("superadmin"), body: { unitCostEnteredAmount: 12000, unitCostEnteredCurrency: "FC" } });
  const row = (await salesSheet()).body.rows.find((item) => item.product === "Veste");
  // Family price 16,000 (normal 20,000, cost 10,000): revenue 16,000, profit 6,000.
  assert.deepEqual([row.quantitySold, row.revenue.fc, row.purchaseCost.fc, row.profit.fc], [1, 16000, 10000, 6000]);
});

itest("purchase cost and profit are only returned to the superadmin and shareholders, per category", async () => {
  const clothes = await createProduct({ name: "C", price: 20000, unitCost: 10000, stock: 10 });
  const shoes = await createProduct({ name: "S", price: 50000, unitCost: 30000, stock: 10, mainCategory: "SHOES" });
  await sell([[clothes, 1, 20000], [shoes, 1, 50000]]);
  const manager = await salesSheet("reportsManager");
  assert.equal(manager.status, 200);
  assert.equal(manager.body.financialsVisible, false);
  assert.ok(manager.body.rows.every((row) => row.purchaseCost === undefined && row.profit === undefined));
  assert.equal(manager.body.summary.profit, undefined);
  assert.doesNotMatch(JSON.stringify(manager.body), /purchaseCost|profit/i);

  const shareholder = await salesSheet("shoesShareholder", `${todayQuery()}&category=CLOTHES`);
  assert.equal(shareholder.body.category, "SHOES");
  assert.deepEqual(shareholder.body.rows.map((row) => [row.product, row.profit.fc]), [["S", 20000]]);
});

itest("the sales sheet lists, per product, each FC price it was sold at and the pieces that left at that price", async () => {
  const shirt = await createProduct({ name: "Chemise", price: 20000, unitCost: 10000, stock: 20 });
  const tie = await createProduct({ name: "Cravate", price: 20000, unitCost: 10000, stock: 20 });
  assert.equal((await sell([[shirt, 4, 15000], [tie, 1, 20000]])).status, 201); // 4 shirts at the discounted 15,000 FC
  assert.equal((await sell([[shirt, 1, 20000]])).status, 201); // 1 shirt at its normal 20,000 FC

  const { body } = await salesSheet();
  const row = (name) => body.rows.find((item) => item.product === name);
  assert.equal(row("Chemise").quantitySold, 5);
  assert.deepEqual(row("Chemise").prices.map((price) => [price.currency, price.unitPrice.fc, price.quantity, price.revenue.fc]), [
    ["FC", 20000, 1, 20000],
    ["FC", 15000, 4, 60000],
  ]);
  assert.deepEqual(row("Chemise").revenue, { fc: 80000 }, "revenue = sum of price x pieces");
  assert.doesNotMatch(JSON.stringify(body), /"usd"|USD/, "no dollar amount anywhere");
  assert.equal(body.summary.unitsSold, 6);

  // Without financial access the price and pieces are still shown.
  const manager = await salesSheet("reportsManager");
  assert.deepEqual(manager.body.rows.find((item) => item.product === "Chemise").prices.map((price) => price.quantity), [1, 4]);
});
