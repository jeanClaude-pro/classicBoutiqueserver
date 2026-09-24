// The signed-in superadministrator must never be able to lock itself out.
const test = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, createIntegrationContext } = require("./helpers/integrationContext");
const { createUser } = require("./helpers/testApp");
const User = require("../models/User");

const ctx = createIntegrationContext();
test.before(ctx.setup);
test.after(ctx.teardown);
const itest = (name, fn) => test(name, { skip: SKIP }, fn);

itest("a superadmin cannot deactivate or demote their own account", async () => {
  const self = ctx.users.superadmin;
  const status = await ctx.request("PUT", `/users/${self.user._id}/status`, { token: self.token });
  assert.equal(status.status, 400);
  assert.match(status.body.message, /propre compte/);
  const role = await ctx.request("PUT", `/users/${self.user._id}/role`, { token: self.token, body: { role: "staff" } });
  assert.equal(role.status, 400);
  const stored = await User.findById(self.user._id).lean();
  assert.equal(stored.isActive, true);
  assert.equal(stored.role, "superadmin");
  // The account still works afterwards.
  assert.equal((await ctx.request("GET", "/users", { token: self.token })).status, 200);
});

itest("a superadmin can still deactivate and reactivate another account", async () => {
  const other = await createUser("staff");
  const off = await ctx.request("PUT", `/users/${other.user._id}/status`, { token: ctx.token("superadmin") });
  assert.equal(off.status, 200);
  assert.equal(off.body.user.isActive, false);
  const blocked = await ctx.request("GET", "/sales", { token: other.token });
  assert.equal(blocked.status, 403, "a deactivated account is refused on its next request");
  const on = await ctx.request("PUT", `/users/${other.user._id}/status`, { token: ctx.token("superadmin") });
  assert.equal(on.body.user.isActive, true);
});
