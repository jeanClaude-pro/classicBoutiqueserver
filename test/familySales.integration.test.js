const test = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, createIntegrationContext } = require("./helpers/integrationContext");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const Sale = require("../models/Sale");
const StockMovement = require("../models/StockMovement");

const ctx = createIntegrationContext();
test.before(ctx.setup);
test.after(ctx.teardown);
test.beforeEach(ctx.reset);
const itest = (name, fn) => test(name, { skip: SKIP }, fn);

let keyCounter = 0;
async function familyBody(product, customer, overrides = {}) {
  await ctx.setRate(2850);
  keyCounter += 1;
  return {
    customer: { name: customer.name, phone: customer.phone || "" },
    familyMemberId: String(customer._id), isFamilySale: true, isWalkIn: false,
    offline: false, exchangeRate: 2850, paymentMethod: "cash", requestKey: `family-${keyCounter}-${Date.now()}`,
    items: [{ productId: String(product._id), quantity: 1, price: 15, enteredPrice: 15, enteredCurrency: "USD", exchangeRate: 2850 }],
    ...overrides,
  };
}
const postSale = (role, body) => ctx.request("POST", "/sales", { token: ctx.token(role), body });

// ---------------------------------------------------------------- family status

itest("only the operational superadmin can grant family status", async () => {
  const customer = await Customer.create({ name: "Alice", phone: "0991000001" });
  for (const role of ["manager", "cashier_supervisor", "staff"]) {
    const denied = await ctx.request("PUT", `/customers/${customer._id}`, { token: ctx.token(role), body: { isFamilyMember: true } });
    assert.equal(denied.status, 403, role);
  }
  // Shareholder ("admin") accounts are read-only and have no Customers module.
  const shareholder = await ctx.request("PUT", `/customers/${customer._id}`, { token: ctx.token("clothesShareholder"), body: { isFamilyMember: true } });
  assert.equal(shareholder.status, 403);
  assert.equal((await Customer.findById(customer._id)).isFamilyMember, false);

  const allowed = await ctx.request("PUT", `/customers/${customer._id}`, { token: ctx.token("superadmin"), body: { isFamilyMember: true } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.isFamilyMember, true);
  const stored = await Customer.findById(customer._id).lean();
  assert.equal(String(stored.familyStatusUpdatedBy), String(ctx.users.superadmin.user._id));
  assert.ok(stored.familyStatusUpdatedAt instanceof Date);

  const removed = await ctx.request("PUT", `/customers/${customer._id}`, { token: ctx.token("superadmin"), body: { isFamilyMember: false } });
  assert.equal(removed.body.isFamilyMember, false);
});

itest("family status must be a real boolean and legacy customers default to ordinary", async () => {
  await Customer.collection.insertOne({ name: "Legacy", phone: "0991000010", totalPurchases: 0, totalSpent: 0 });
  const legacy = await Customer.findOne({ phone: "0991000010" });
  assert.equal(legacy.isFamilyMember, false);
  const coerced = await ctx.request("PUT", `/customers/${legacy._id}`, { token: ctx.token("superadmin"), body: { isFamilyMember: "true" } });
  assert.equal(coerced.status, 400);
});

itest("creating a family member is superadmin-only and never duplicates a phone", async () => {
  const denied = await ctx.request("POST", "/customers", { token: ctx.token("manager"), body: { name: "Bob", phone: "0991000020", isFamilyMember: true } });
  assert.equal(denied.status, 403);
  assert.equal(await Customer.countDocuments({}), 0);

  const created = await ctx.request("POST", "/customers", { token: ctx.token("superadmin"), body: { name: "Bob", phone: "0991000020", isFamilyMember: true } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.isFamilyMember, true);
  const duplicate = await ctx.request("POST", "/customers", { token: ctx.token("superadmin"), body: { name: "Bobby", phone: "0991000020", isFamilyMember: true } });
  assert.equal(duplicate.status, 409);
});

itest("the family search returns registered family members only", async () => {
  await Customer.create({ name: "Martin Famille", phone: "0991000030", isFamilyMember: true });
  await Customer.create({ name: "Martin Client", phone: "0991000031" });
  const byName = await ctx.request("GET", "/customers?familyOnly=true&search=Martin", { token: ctx.token("superadmin") });
  assert.equal(byName.status, 200);
  assert.deepEqual(byName.body.customers.map((item) => item.name), ["Martin Famille"]);
  const byPhone = await ctx.request("GET", "/customers?familyOnly=true&search=0991000031", { token: ctx.token("superadmin") });
  assert.deepEqual(byPhone.body.customers, []);
});

// ------------------------------------------------------------------ family sale

itest("a registered family member may receive a one-item discount with authoritative accounting", async () => {
  const customer = await Customer.create({ name: "Famille", phone: "0991000002", isFamilyMember: true });
  const product = await ctx.product("CLOTHES", 10, 20, 10);
  // The client-side customer snapshot is ignored: the server copies the record.
  const body = await familyBody(product, customer, { customer: { name: "Forged name", phone: "000" }, familyMemberName: "Forged" });
  const response = await postSale("superadmin", body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const sale = await Sale.findById(response.body._id).lean();
  assert.equal(sale.isFamilySale, true);
  assert.equal(String(sale.familyMemberId), String(customer._id));
  assert.equal(String(sale.customerId), String(customer._id));
  assert.equal(sale.familyMemberName, "Famille");
  assert.equal(sale.customer.name, "Famille");
  assert.equal(String(sale.familyAuthorizedBy), String(ctx.users.superadmin.user._id));
  assert.ok(sale.familyAuthorizedAt instanceof Date);
  assert.deepEqual(
    [sale.items[0].referenceUnitSellingPrice, sale.items[0].discountApplied, sale.items[0].discountPerUnit, sale.items[0].priceUSD],
    [20, true, 5, 15],
  );
  assert.equal(sale.exchangeRate, 2850);
  assert.deepEqual([sale.total, sale.costOfGoodsSold, sale.grossProfit, sale.clothesShareholderProfit], [15, 10, 5, 5]);
  assert.equal((await Product.findById(product._id)).stock, 9);
  const updatedCustomer = await Customer.findById(customer._id).lean();
  assert.deepEqual([updatedCustomer.totalPurchases, updatedCustomer.totalSpent], [1, 15]);
  const movement = await StockMovement.findOne({ productId: product._id, kind: "SALE" }).lean();
  assert.deepEqual([movement.quantityDelta, movement.balanceBefore, movement.balanceAfter, movement.mainCategory], [-1, 10, 9, "CLOTHES"]);
});

itest("a one-item SHOES family discount still splits actual profit 50/50", async () => {
  const customer = await Customer.create({ name: "Famille Shoes", phone: "0991000006", isFamilyMember: true });
  const product = await ctx.product("SHOES", 10, 20, 10);
  const response = await postSale("superadmin", await familyBody(product, customer));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const sale = await Sale.findById(response.body._id).lean();
  assert.deepEqual([sale.grossProfit, sale.shoeShareholder1Profit, sale.shoeShareholder2Profit], [5, 2.5, 2.5]);
  assert.ok(!sale.clothesShareholderProfit);
});

itest("an FC-entered family discount keeps its exact FC snapshot", async () => {
  const customer = await Customer.create({ name: "Famille FC", phone: "0991000007", isFamilyMember: true });
  const product = await ctx.product("CLOTHES", 10000 / 2850, 20000 / 2850, 10);
  const body = await familyBody(product, customer, {
    items: [{ productId: String(product._id), quantity: 1, price: 18000 / 2850, enteredPrice: 18000, enteredCurrency: "FC", exchangeRate: 2850 }],
  });
  const response = await postSale("superadmin", body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const sale = await Sale.findById(response.body._id).lean();
  assert.deepEqual([sale.items[0].enteredPrice, sale.items[0].priceFC, sale.items[0].revenueFC, sale.items[0].exchangeRate], [18000, 18000, 18000, 2850]);
  assert.equal(sale.items[0].discountApplied, true);
});

itest("normal one-item discounts remain refused, for the superadmin too, without the family flag", async () => {
  const customer = await Customer.create({ name: "Famille", phone: "0991000008", isFamilyMember: true });
  const product = await ctx.product("CLOTHES", 10, 20, 10);
  const body = await familyBody(product, customer);
  const asNormal = { ...body, isFamilySale: false };
  const normal = await postSale("superadmin", asNormal);
  assert.equal(normal.status, 400);
  assert.equal(normal.body.error, "DISCOUNT_QUANTITY_REQUIRED");
  // A truthy-but-not-boolean flag is not a family sale either.
  const stringFlag = await postSale("superadmin", { ...body, isFamilySale: "true", requestKey: `${body.requestKey}-s` });
  assert.equal(stringFlag.body.error, "DISCOUNT_QUANTITY_REQUIRED");
  assert.equal(await Sale.countDocuments({}), 0);
  assert.equal((await Product.findById(product._id)).stock, 10);
});

itest("ordinary clients, non-admins, offline flags and tampered payloads cannot use the exception", async () => {
  const ordinary = await Customer.create({ name: "Ordinary", phone: "0991000003" });
  const family = await Customer.create({ name: "Family", phone: "0991000004", isFamilyMember: true });
  const product = await ctx.product("SHOES", 10, 20, 20);

  let body = await familyBody(product, ordinary);
  assert.equal((await postSale("superadmin", body)).body.error, "FAMILY_MEMBER_INVALID");
  body = await familyBody(product, ordinary, { familyMemberId: "64b000000000000000000000" });
  assert.equal((await postSale("superadmin", body)).body.error, "FAMILY_MEMBER_INVALID");
  body = await familyBody(product, family, { familyMemberId: { $ne: null } });
  assert.equal((await postSale("superadmin", body)).status, 400);

  body = await familyBody(product, family);
  for (const role of ["manager", "cashier_supervisor", "staff"]) {
    const denied = await postSale(role, { ...body, requestKey: `${body.requestKey}-${role}` });
    assert.equal(denied.status, 403, role);
    assert.equal(denied.body.error, "FAMILY_SALE_FORBIDDEN");
  }
  assert.equal((await postSale("clothesShareholder", body)).status, 403);
  assert.equal((await postSale("superadmin", { ...body, offline: true })).body.error, "FAMILY_SALE_ONLINE_REQUIRED");
  assert.equal((await postSale("superadmin", { ...body, isWalkIn: true })).body.error, "FAMILY_MEMBER_REQUIRED");
  // Reservations can no longer be created at all.
  assert.equal((await postSale("superadmin", { ...body, type: "reservation" })).body.error, "SALE_TYPE_INVALID");
  // Client prices cannot go under the protected acquisition-cost floor.
  const tooLow = await postSale("superadmin", { ...body, requestKey: "too-low", items: [{ ...body.items[0], price: 9, enteredPrice: 9 }] });
  assert.equal(tooLow.body.error, "PRICE_TOO_LOW");

  assert.equal(await Sale.countDocuments({}), 0);
  assert.equal((await Product.findById(product._id)).stock, 20);
});

itest("a member whose family status was revoked is refused at checkout", async () => {
  const family = await Customer.create({ name: "Revoked", phone: "0991000009", isFamilyMember: true });
  const product = await ctx.product("CLOTHES", 10, 20, 5);
  const body = await familyBody(product, family);
  await ctx.request("PUT", `/customers/${family._id}`, { token: ctx.token("superadmin"), body: { isFamilyMember: false } });
  const response = await postSale("superadmin", body);
  assert.equal(response.body.error, "FAMILY_MEMBER_INVALID");
  assert.equal((await Product.findById(product._id)).stock, 5);
});

itest("family sale idempotency records one sale and one stock deduction", async () => {
  const customer = await Customer.create({ name: "Family", phone: "0991000005", isFamilyMember: true });
  const product = await ctx.product("SHOES", 10, 20, 20);
  const body = await familyBody(product, customer, { requestKey: "family-repeat" });
  const first = await postSale("superadmin", body);
  const second = await postSale("superadmin", body);
  assert.equal(first.status, 201); assert.equal(second.status, 200);
  assert.equal(second.body._id, first.body._id);
  assert.equal(await Sale.countDocuments({ requestKey: "family-repeat" }), 1);
  assert.equal(await StockMovement.countDocuments({ productId: product._id, kind: "SALE" }), 1);
  assert.equal((await Product.findById(product._id)).stock, 19);
  // The same key with a different payload is a conflict, not a second sale.
  const changed = await postSale("superadmin", { ...body, items: [{ ...body.items[0], quantity: 2 }] });
  assert.equal(changed.status, 409);
  // Another user cannot replay the superadmin's family sale key.
  assert.equal((await postSale("manager", body)).status, 409);
});
