// End-to-end checks of the security hardening, on the throw-away replica set.
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { SKIP, createIntegrationContext } = require("./helpers/integrationContext");
const { createUser } = require("./helpers/testApp");
const User = require("../models/User");
const Sale = require("../models/Sale");
const Product = require("../models/Product");
const LoginThrottle = require("../models/LoginThrottle");
const AuditLog = require("../models/AuditLog");

const ctx = createIntegrationContext();
test.before(ctx.setup);
test.after(ctx.teardown);
test.beforeEach(async () => {
  if (SKIP) return;
  await ctx.reset();
  await LoginThrottle.deleteMany({});
});
const itest = (name, fn) => test(name, { skip: SKIP }, fn);

const PASSWORD = "Correct-Horse-42";
let emailCounter = 0;
async function userWithPassword(role = "manager", extra = {}) {
  emailCounter += 1;
  const email = `login-${emailCounter}-${Date.now()}@test.local`;
  const user = await User.create({ username: `login${emailCounter}`, email, password: await bcrypt.hash(PASSWORD, 4), role, ...extra });
  return { user, email };
}
const login = (email, password = PASSWORD) => ctx.request("POST", "/auth/login", { body: { email, password } });

// ---------- Authentication ----------

itest("no token and invalid token are 401", async () => {
  assert.equal((await ctx.request("GET", "/sales")).status, 401);
  assert.equal((await ctx.request("GET", "/sales", { token: "not-a-jwt" })).status, 401);
  const wrongKey = jwt.sign({ id: String(ctx.users.manager.user._id) }, "another-secret-that-is-long-enough-123456");
  assert.equal((await ctx.request("GET", "/sales", { token: wrongKey })).status, 401);
  const noneAlg = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ id: String(ctx.users.superadmin.user._id) })).toString("base64url")}.`;
  assert.equal((await ctx.request("GET", "/users", { token: noneAlg })).status, 401, "alg=none is refused");
});

itest("valid staff and admin tokens reach their own routes", async () => {
  assert.equal((await ctx.request("GET", "/sales", { token: ctx.token("staff") })).status, 200);
  assert.equal((await ctx.request("GET", "/users", { token: ctx.token("superadmin") })).status, 200);
});

itest("a deactivated account's token is refused with 401", async () => {
  const other = await createUser("manager");
  assert.equal((await ctx.request("GET", "/sales", { token: other.token })).status, 200);
  await ctx.request("PUT", `/users/${other.user._id}/status`, { token: ctx.token("superadmin") });
  const refused = await ctx.request("GET", "/sales", { token: other.token });
  assert.equal(refused.status, 401);
  // Reactivating does not resurrect the old token: deactivation bumped tokenVersion.
  await ctx.request("PUT", `/users/${other.user._id}/status`, { token: ctx.token("superadmin") });
  assert.equal((await ctx.request("GET", "/sales", { token: other.token })).status, 401);
});

itest("a token issued before a role change is revoked", async () => {
  const { user, email } = await userWithPassword("manager");
  const { token } = (await login(email)).body;
  assert.equal((await ctx.request("GET", "/sales", { token })).status, 200);
  const change = await ctx.request("PUT", `/users/${user._id}/role`, { token: ctx.token("superadmin"), body: { role: "cashier_supervisor" } });
  assert.equal(change.status, 200);
  const old = await ctx.request("GET", "/sales", { token });
  assert.equal(old.status, 401);
  assert.equal(old.body.code, "SESSION_REVOKED");
  const fresh = (await login(email)).body;
  assert.equal(fresh.user.role, "cashier_supervisor");
  assert.equal((await ctx.request("GET", "/sales", { token: fresh.token })).status, 200);
});

itest("logout ends the session server-side", async () => {
  const { email } = await userWithPassword("manager");
  const { token } = (await login(email)).body;
  assert.equal((await ctx.request("GET", "/users/me", { token })).status, 200);
  assert.equal((await ctx.request("POST", "/auth/logout", { token })).status, 200);
  assert.equal((await ctx.request("GET", "/users/me", { token })).status, 401);
  // Another session of the same account is unaffected.
  const other = (await login(email)).body.token;
  assert.equal((await ctx.request("GET", "/users/me", { token: other })).status, 200);
});

itest("public registration creates an inactive staff account without a token", async () => {
  const email = `signup-${Date.now()}@test.local`;
  const response = await ctx.request("POST", "/auth/register", { body: { username: "New", email, password: PASSWORD, role: "superadmin", isActive: true } });
  assert.equal(response.status, 201);
  assert.equal(response.body.token, undefined);
  assert.equal(response.body.pendingActivation, true);
  const stored = await User.findOne({ email }).lean();
  assert.equal(stored.role, "staff");
  assert.equal(stored.isActive, false);
  const attempt = await login(email);
  assert.equal(attempt.status, 403);
  assert.equal(attempt.body.token, undefined);
});

// ---------- Authorization ----------

itest("module permissions are enforced on the API, not only in the interface", async () => {
  const bare = ctx.token("bareStaff");
  assert.equal((await ctx.request("GET", "/sales", { token: bare })).status, 403);
  assert.equal((await ctx.request("POST", "/sales", { token: bare, body: { isWalkIn: true, items: [] } })).status, 403);
  assert.equal((await ctx.request("GET", "/customers", { token: bare })).status, 403);
  assert.equal((await ctx.request("POST", "/entries", { token: bare, body: { amount: 5, source: "x", category: "y" } })).status, 403);
  assert.equal((await ctx.request("GET", "/products/stock-sheet", { token: bare })).status, 403);
  assert.equal((await ctx.request("GET", "/users", { token: ctx.token("staff") })).status, 403, "staff → admin endpoint");
  assert.equal((await ctx.request("GET", "/analytics/sales-sheet", { token: ctx.token("manager") })).status, 403, "Reports is not a manager default");
  // A custom permission list replaces the role defaults.
  const restricted = await createUser("manager", { permissions: ["/sales"] });
  assert.equal((await ctx.request("POST", "/entries", { token: restricted.token, body: { amount: 5, source: "x", category: "y" } })).status, 403);
  assert.equal((await ctx.request("GET", "/sales", { token: restricted.token })).status, 200);
});

itest("only superadmin and manager may correct a completed sale", async () => {
  const product = await ctx.product("CLOTHES", 10, 20);
  const sale = (await ctx.sell([{ product, quantity: 2 }])).body;
  const body = { isWalkIn: true, items: [{ productId: String(product._id), quantity: 1, price: 20 }], paymentMethod: "cash", reason: "fix" };
  for (const role of ["cashier_supervisor", "inventory_manager", "staff"]) {
    assert.equal((await ctx.request("PUT", `/sales/${sale._id}`, { token: ctx.token(role), body })).status, 403, role);
  }
  assert.equal((await Product.findById(product._id)).stock, 998, "refused corrections changed nothing");
  const ok = await ctx.request("PUT", `/sales/${sale._id}`, { token: ctx.token("manager"), body });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await Product.findById(product._id)).stock, 999);
});

itest("role hierarchy: no self-promotion, shareholders cannot manage users", async () => {
  const staff = ctx.users.staff;
  assert.equal((await ctx.request("PUT", `/users/${staff.user._id}/role`, { token: staff.token, body: { role: "superadmin" } })).status, 403);
  const shareholder = ctx.users.clothesShareholder;
  assert.equal((await ctx.request("PUT", `/users/${staff.user._id}/role`, { token: shareholder.token, body: { role: "superadmin" } })).status, 403);
  assert.equal((await ctx.request("PUT", `/users/${shareholder.user._id}/role`, { token: shareholder.token, body: { role: "superadmin" } })).status, 403);
  const self = ctx.users.superadmin;
  assert.equal((await ctx.request("PUT", `/users/${self.user._id}/role`, { token: self.token, body: { role: "staff" } })).status, 400);
  assert.equal((await ctx.request("DELETE", `/users/${self.user._id}`, { token: self.token })).status, 400);
  // Profile updates cannot carry role or activation changes.
  await ctx.request("PUT", `/users/${staff.user._id}/profile`, { token: staff.token, body: { username: "cashier", role: "superadmin", isActive: true, permissions: ["/admin"] } });
  const stored = await User.findById(staff.user._id).lean();
  assert.equal(stored.role, "staff");
  assert.deepEqual(stored.permissions, ["/", "/sales"]);
});

itest("permission and action lists only accept known values", async () => {
  const target = await createUser("manager");
  const perms = await ctx.request("PUT", `/users/${target.user._id}/permissions`, { token: ctx.token("superadmin"), body: { permissions: ["/sales", "/admin", "/anything"] } });
  assert.equal(perms.status, 200);
  assert.deepEqual(perms.body.permissions, ["/sales"]);
  assert.equal((await ctx.request("PUT", `/users/${target.user._id}/actions`, { token: ctx.token("superadmin"), body: { actionPermissions: ["delete_everything"] } })).status, 400);
  assert.equal((await ctx.request("PUT", `/users/${target.user._id}/permissions`, { token: ctx.token("superadmin"), body: { permissions: [{ $ne: 1 }] } })).status, 400);
});

itest("non-admin roles only reach today's entry history", async () => {
  const entry = await ctx.request("POST", "/entries", { token: ctx.token("manager"), body: { amount: 5, source: "Caisse", category: "Apport" } });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));
  const Entry = require("../models/Entry");
  await ctx.backdate(Entry, entry.body._id, "2024-01-10T10:00:00.000Z");
  assert.equal((await ctx.request("GET", `/entries/${entry.body._id}/history`, { token: ctx.token("manager") })).status, 404);
  assert.equal((await ctx.request("GET", `/entries/${entry.body._id}/history`, { token: ctx.token("superadmin") })).status, 200);
});

// ---------- Input tampering ----------

itest("protected sale fields are set by the server, never by the request", async () => {
  const product = await ctx.product("SHOES", 10, 20);
  const response = await ctx.request("POST", "/sales", {
    token: ctx.token("staff"),
    body: {
      isWalkIn: true, paymentMethod: "cash", items: [{ productId: String(product._id), quantity: 1, price: 20 }],
      role: "admin", stock: 999999, isSuperAdmin: true, isAdmin: true, createdAt: "2020-01-01", salesPerson: "Someone Else",
      occurredAt: "2020-01-01", total: 1, subtotal: 1, status: "pending", createdBy: String(ctx.users.superadmin.user._id),
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const stored = await Sale.findById(response.body._id).lean();
  const cashier = await User.findById(ctx.users.staff.user._id).lean();
  assert.equal(stored.salesPerson, cashier.username);
  assert.equal(stored.total, 20, "the server recalculates the total");
  assert.equal(stored.status, "completed");
  assert.equal(stored.occurredAt, undefined, "online sales are dated by the server");
  assert.equal(String(stored.createdBy), String(ctx.users.staff.user._id));
  assert.ok(Date.now() - new Date(stored.createdAt).getTime() < 60_000);
  assert.equal((await Product.findById(product._id)).stock, 999);
});

itest("reservations and expense-type sales can no longer be created through /sales", async () => {
  const product = await ctx.product("SHOES", 10, 20);
  for (const type of ["reservation", "expense"]) {
    const response = await ctx.request("POST", "/sales", {
      token: ctx.token("staff"),
      body: { type, customer: { name: "A", phone: "0990000001" }, items: [{ productId: String(product._id), quantity: 1, price: 20 }], reason: "x", recipientName: "x", recipientPhone: "1", amount: 50 },
    });
    assert.equal(response.status, 400, type);
  }
  assert.equal(await Sale.countDocuments({}), 0);
});

itest("invalid quantities, ids and oversized carts are rejected", async () => {
  const product = await ctx.product("SHOES", 10, 20);
  const post = (items) => ctx.request("POST", "/sales", { token: ctx.token("staff"), body: { isWalkIn: true, paymentMethod: "cash", items } });
  for (const quantity of [-1, 0, 1.5, "abc", "Infinity", null]) {
    assert.equal((await post([{ productId: String(product._id), quantity, price: 20 }])).status, 400, `quantity ${quantity}`);
  }
  assert.equal((await post([{ productId: "not-an-id", quantity: 1, price: 20 }])).status, 400);
  assert.equal((await post(Array.from({ length: 201 }, () => ({ productId: String(product._id), quantity: 1, price: 20 })))).status, 400);
  assert.equal((await ctx.request("GET", "/sales/not-an-id", { token: ctx.token("staff") })).status, 400);
  assert.equal((await Product.findById(product._id)).stock, 1000);
});

itest("a tampered unit price below the protected floor is refused", async () => {
  const product = await ctx.product("SHOES", 60, 100);
  const response = await ctx.request("POST", "/sales", {
    token: ctx.token("staff"),
    body: { isWalkIn: true, paymentMethod: "cash", total: 600, items: [{ productId: String(product._id), quantity: 6, price: 1 }] },
  });
  assert.equal(response.status, 400);
  assert.equal(await Sale.countDocuments({}), 0);
  const audit = await AuditLog.findOne({ action: "SALE_DISCOUNT_REJECTED" }).lean();
  assert.ok(audit, "refused discounts are audited");
});

itest("operator and regex injection in filters is neutralized", async () => {
  assert.equal((await ctx.request("POST", "/auth/login", { body: { email: { $ne: null }, password: { $ne: null } } })).status, 400);
  await ctx.request("POST", "/entries", { token: ctx.token("manager"), body: { amount: 5, source: "Caisse", category: "Apport", description: "abc" } });
  const wildcard = await ctx.request("GET", `/entries?search=${encodeURIComponent(".*")}`, { token: ctx.token("manager") });
  assert.equal(wildcard.status, 200);
  assert.equal(wildcard.body.data.length, 0, ".* is matched literally");
  const redos = await ctx.request("GET", `/expenses?search=${encodeURIComponent("(a+)+$")}&recordedBy=${encodeURIComponent("(.*){1,32000}")}`, { token: ctx.token("manager") });
  assert.equal(redos.status, 200);
  const huge = await ctx.request("GET", "/sales?limit=1000000", { token: ctx.token("staff") });
  assert.equal(huge.body.pagination.limit, 100);
});

// ---------- Login abuse ----------

itest("five failed logins lock that account from this IP, without revealing the duration", async () => {
  const { email } = await userWithPassword("manager");
  const { email: colleague } = await userWithPassword("cashier_supervisor");
  for (let i = 0; i < 5; i += 1) assert.equal((await login(email, "wrong-password")).status, 401);
  const locked = await login(email);
  assert.equal(locked.status, 429, "even the right password is refused while locked");
  assert.deepEqual(locked.body, { message: "Too many attempts. Please try again later." });
  for (const header of Object.keys(locked.headers)) {
    assert.doesNotMatch(header, /^(retry-after|ratelimit|x-ratelimit)/i, `header ${header} must not be sent`);
  }
  assert.equal((await login(colleague)).status, 200, "a colleague on the same IP can still sign in");

  // A superadmin can unlock the account.
  const target = await User.findOne({ email }).lean();
  assert.equal((await ctx.request("DELETE", `/users/${target._id}/login-lock`, { token: ctx.token("superadmin") })).status, 200);
  assert.equal((await login(email)).status, 200);
  assert.ok(await AuditLog.exists({ action: "LOGIN_LOCKOUT" }));
});

itest("unknown email and wrong password are indistinguishable; success resets the counter", async () => {
  const { email } = await userWithPassword("manager");
  const unknown = await login("nobody@test.local", "whatever-password");
  const wrong = await login(email, "wrong-password");
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.body, wrong.body);
  for (let i = 0; i < 3; i += 1) await login(email, "wrong-password");
  assert.equal((await login(email)).status, 200, "4 failures, then success");
  for (let i = 0; i < 4; i += 1) assert.equal((await login(email, "wrong-password")).status, 401, "counter restarted after success");
  assert.equal(await LoginThrottle.countDocuments({ kind: "account", email, blockedUntil: { $ne: null } }), 0);
});

itest("the lockout survives because it is stored in MongoDB", async () => {
  const { email } = await userWithPassword("manager");
  for (let i = 0; i < 5; i += 1) await login(email, "wrong-password");
  const row = await LoginThrottle.findOne({ kind: "account", email }).lean();
  assert.ok(row.blockedUntil > new Date(Date.now() + 60 * 60 * 1000), "blocked for about two hours");
});

// ---------- Inventory and sales ----------

itest("two simultaneous sales for the last unit: one succeeds, stock never goes negative", async () => {
  const product = await ctx.product("SHOES", 10, 20, 1);
  const body = (key) => ({ isWalkIn: true, paymentMethod: "cash", requestKey: key, items: [{ productId: String(product._id), quantity: 1, price: 20 }] });
  const results = await Promise.all([
    ctx.request("POST", "/sales", { token: ctx.token("staff"), body: body("race-a") }),
    ctx.request("POST", "/sales", { token: ctx.token("staff"), body: body("race-b") }),
  ]);
  const statuses = results.map((r) => r.status).sort();
  // The loser is refused either by the pre-check (400) or by the atomic
  // conditional decrement inside the transaction (409).
  assert.equal(statuses[0], 201, JSON.stringify(results.map((r) => r.body)));
  assert.ok([400, 409].includes(statuses[1]), JSON.stringify(results.map((r) => r.body)));
  assert.equal((await Product.findById(product._id)).stock, 0);
  assert.equal(await Sale.countDocuments({}), 1);
});

itest("the same idempotency key creates one sale", async () => {
  const product = await ctx.product("SHOES", 10, 20);
  const body = { isWalkIn: true, paymentMethod: "cash", requestKey: "dup-1", items: [{ productId: String(product._id), quantity: 2, price: 20 }] };
  const [a, b] = await Promise.all([1, 2].map(() => ctx.request("POST", "/sales", { token: ctx.token("staff"), body })));
  assert.ok([200, 201].includes(a.status) && [200, 201].includes(b.status));
  assert.equal(await Sale.countDocuments({}), 1);
  assert.equal((await Product.findById(product._id)).stock, 998);
});

// ---------- Responses and audit ----------

itest("responses never expose password hashes, token versions or staff-hidden costs", async () => {
  const users = await ctx.request("GET", "/users", { token: ctx.token("superadmin") });
  assert.doesNotMatch(JSON.stringify(users.body), /password|tokenVersion/);
  const me = await ctx.request("GET", "/users/me", { token: ctx.token("staff") });
  assert.doesNotMatch(JSON.stringify(me.body), /password|tokenVersion/);
  await ctx.product("SHOES", 10, 20);
  const products = await ctx.request("GET", "/products", { token: ctx.token("staff") });
  assert.equal(products.status, 200);
  assert.ok(products.body.every((product) => product.unitCost === undefined && product.totalAcquisitionCost === undefined));
});

itest("sensitive actions are audited, and the audit trail is read-only and superadmin-only", async () => {
  const product = await ctx.product("SHOES", 10, 20);
  const sale = (await ctx.sell([{ product, quantity: 1 }])).body;
  assert.equal((await ctx.request("PATCH", `/sales/${sale._id}/void`, { token: ctx.token("superadmin"), body: { reason: "test" } })).status, 200);
  assert.equal((await ctx.request("DELETE", `/sales/${sale._id}`, { token: ctx.token("superadmin") })).status, 200);
  const logs = await ctx.request("GET", "/audit-logs", { token: ctx.token("superadmin") });
  assert.equal(logs.status, 200);
  const actions = logs.body.data.map((row) => row.action);
  assert.ok(actions.includes("SALE_VOIDED") && actions.includes("SALE_DELETED"));
  const deleted = logs.body.data.find((row) => row.action === "SALE_DELETED");
  assert.equal(deleted.before.saleId, sale.saleId, "the deleted sale survives in the audit trail");
  assert.equal(deleted.before.requestFingerprint, undefined);
  assert.equal((await ctx.request("GET", "/audit-logs", { token: ctx.token("manager") })).status, 403);
  assert.equal((await ctx.request("DELETE", `/audit-logs/${deleted._id}`, { token: ctx.token("superadmin") })).status, 404);
  await assert.rejects(AuditLog.updateOne({ _id: deleted._id }, { $set: { action: "X" } }), /immutable/);
});
