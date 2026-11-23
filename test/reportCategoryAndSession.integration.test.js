// Reports restricted to one category, the server-confirmed session check and
// the reports password confirmation, against a real MongoDB replica set.
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { SKIP, createIntegrationContext } = require("./helpers/integrationContext");
const Entry = require("../models/Entry");
const User = require("../models/User");
const generateToken = require("../utils/generateToken");

const ctx = createIntegrationContext();
test.before(ctx.setup);
test.after(ctx.teardown);
test.beforeEach(ctx.reset);
const itest = (name, fn) => test(name, { skip: SKIP }, fn);

const summary = (query, options = {}) =>
  ctx.request("GET", `/analytics/summary?${new URLSearchParams({ timeframe: "day", ...query })}`, { token: ctx.token("superadmin"), ...options });

async function shopEntry(amount) {
  return Entry.create({
    entryId: `ENTRY-${Math.random().toString(36).slice(2)}`, amount, source: "Apport", category: "Apport",
    createdBy: ctx.users.superadmin.user._id,
  });
}

itest("a category report covers that category only and leaves shop-wide entries and debts out", async () => {
  const clothes = await ctx.product("CLOTHES", 10, 25);
  const shoes = await ctx.product("SHOES", 20, 50);
  assert.equal((await ctx.sell([{ product: clothes, quantity: 2 }])).status, 201);
  assert.equal((await ctx.sell([{ product: shoes, quantity: 1 }, { product: clothes, quantity: 1 }])).status, 201);
  await shopEntry(100);

  const all = await summary({});
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.scope, { category: "ALL", shopWideIncluded: true });
  assert.equal(all.body.data.totalRevenue, 125);
  assert.equal(all.body.data.totalEntries, 100);
  assert.equal(all.body.data.entriesIncluded, true);
  assert.ok(all.body.data.reimbursement, "debts are part of the whole-shop view");
  assert.deepEqual(Object.keys(all.body.data.categoryBreakdown).sort(), ["CLOTHES", "SHOES"]);

  const shoesOnly = await summary({ category: "SHOES" });
  assert.equal(shoesOnly.status, 200, JSON.stringify(shoesOnly.body));
  assert.deepEqual(shoesOnly.body.scope, { category: "SHOES", shopWideIncluded: false });
  const data = shoesOnly.body.data;
  assert.equal(data.totalRevenue, 50, "only the SHOES line of the mixed sale");
  assert.equal(data.totalSales, 1);
  assert.equal(data.totalEntries, 0, "shop-wide entries are never attributed to a category");
  assert.equal(data.entriesIncluded, false);
  assert.equal(data.reimbursement, undefined, "debts are not attributed to a category");
  assert.equal(data.netRevenue, 50, "category sales - category validated expenses");
  assert.deepEqual(Object.keys(data.categoryBreakdown), ["SHOES"]);
  assert.deepEqual(Object.keys(data.inventoryValuation), ["SHOES"]);
  assert.equal(data.clothesShareholderProfit, 0);
  assert.equal(data.shoeShareholder1Profit, 15, "(50 - 20) / 2");
  assert.ok(data.topProducts.every((row) => row.name.startsWith("SHOES")));

  // A shareholder stays pinned to its own category whatever it asks for.
  const pinned = await ctx.request("GET", "/analytics/summary?timeframe=day&category=CLOTHES", { token: ctx.token("shoesShareholder") });
  assert.equal(pinned.status, 200);
  assert.equal(pinned.body.scope.category, "SHOES");
  assert.equal(pinned.body.data.totalRevenue, 50);
});

itest("superadmin reports require a password confirmation proof from the server", async () => {
  const refused = await summary({}, { reauth: false });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "REAUTH_REQUIRED");
  assert.equal((await ctx.request("GET", "/analytics/sales-sheet", { token: ctx.token("superadmin"), reauth: false })).status, 403);
  assert.equal((await ctx.request("GET", "/analytics/timeseries?from=2026-09-01&to=2026-09-02", { token: ctx.token("superadmin"), reauth: false })).status, 403);
  // Shareholders keep reading their own category without the extra step.
  assert.equal((await ctx.request("GET", "/analytics/summary?timeframe=day", { token: ctx.token("clothesShareholder"), reauth: false })).status, 200);
});

itest("password confirmation never opens a session, is throttled and binds the proof to the session", async () => {
  const password = "correct horse battery staple";
  const owner = await User.create({ username: "owner-reauth", email: "owner-reauth@test.local", password: await bcrypt.hash(password, 4), role: "superadmin", isActive: true });
  const sessionA = generateToken(owner);
  const sessionB = generateToken(owner);

  const wrong = await ctx.request("POST", "/auth/reauth", { token: sessionA, body: { password: "nope" }, reauth: false });
  assert.equal(wrong.status, 403, "a wrong password does not look like an expired session");
  assert.equal(wrong.body.code, "REAUTH_INVALID");
  assert.equal(wrong.body.token, undefined);

  const ok = await ctx.request("POST", "/auth/reauth", { token: sessionA, body: { password }, reauth: false });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.token, undefined, "no new session token is issued");
  assert.equal(ok.body.reauthToken, undefined, "the proof is only in an httpOnly cookie");
  assert.ok(!ok.setCookies.some((cookie) => cookie.startsWith("cb_session=")), "no new session cookie");
  const proofCookie = ok.setCookies.find((cookie) => cookie.startsWith("cb_reauth="));
  assert.match(proofCookie, /HttpOnly/i);
  const proof = decodeURIComponent(proofCookie.split(";")[0].slice("cb_reauth=".length));

  const withProof = await ctx.request("GET", "/analytics/summary?timeframe=day", { token: sessionA, reauth: proof });
  assert.equal(withProof.status, 200);
  const otherSession = await ctx.request("GET", "/analytics/summary?timeframe=day", { token: sessionB, reauth: proof });
  assert.equal(otherSession.status, 403, "a proof only works for the session that confirmed the password");

  // Repeated wrong passwords lock the account exactly like the login form.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await ctx.request("POST", "/auth/reauth", { token: sessionB, body: { password: "wrong" }, reauth: false });
  }
  const locked = await ctx.request("POST", "/auth/reauth", { token: sessionB, body: { password }, reauth: false });
  assert.equal(locked.status, 429);
});

itest("the session endpoint answers who the session belongs to, from the database", async () => {
  const me = await ctx.request("GET", "/auth/session", { token: ctx.token("shoesShareholder") });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, "admin");
  assert.equal(me.body.user.assignedCategory, "SHOES");
  assert.equal(me.body.user.password, undefined);

  const forged = jwt.sign({ id: ctx.users.manager.user._id.toString(), role: "superadmin" }, "not-the-server-secret-but-long-enough");
  assert.equal((await ctx.request("GET", "/auth/session", { token: forged })).status, 401);
  assert.equal((await ctx.request("GET", "/auth/session", {})).status, 401);

  const disabled = await User.create({ username: "gone", email: "gone@test.local", password: "x", role: "staff", isActive: false });
  const disabledToken = jwt.sign({ id: disabled._id.toString() }, process.env.JWT_SECRET);
  const refused = await ctx.request("GET", "/auth/session", { token: disabledToken });
  assert.equal(refused.status, 401);
  assert.equal(refused.body.code, "ACCOUNT_DISABLED");
});
