// Mounts the real routers with the same guard chain as index.js (print routes
// are skipped: they need USB printer drivers).
process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret-that-is-long-enough";
process.env.EMAIL_HOST = "127.0.0.1";
process.env.EMAIL_PORT = "9";

const express = require("express");
const jwt = require("jsonwebtoken");
const { preventNoSqlInjection } = require("../../middleware/security");
const authMiddleware = require("../../middleware/auth");
const { MODULES, blockShareholderMutations, requireAssignedCategory, requireShareholderModule } = require("../../middleware/authorization");
const User = require("../../models/User");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(preventNoSqlInjection);
  const guarded = (modules, categorySensitive = false) => [
    authMiddleware,
    requireShareholderModule(...modules),
    ...(categorySensitive ? [requireAssignedCategory] : []),
    blockShareholderMutations,
  ];
  app.use("/api/sales", ...guarded([MODULES.SALES_HISTORY], true), require("../../routes/sales"));
  app.use("/api/expenses", ...guarded([MODULES.EXPENSES]), require("../../routes/expenses"));
  app.use("/api/entries", ...guarded([MODULES.ENTRIES]), require("../../routes/entries"));
  app.use("/api/analytics", ...guarded([MODULES.REPORTS], true), require("../../routes/analytics"));
  app.use("/api/users", require("../../routes/users"));
  return app;
}

async function startApp() {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return {
    base,
    async request(method, url, { token, body } = {}) {
      const response = await fetch(`${base}${url}`, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: response.status, body: json };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function createUser(role, extra = {}) {
  const user = await User.create({
    username: `${role}-${Math.random().toString(36).slice(2, 8)}`,
    email: `${role}-${Math.random().toString(36).slice(2, 10)}@test.local`,
    password: "not-used-by-token-auth",
    role,
    ...extra,
  });
  return { user, token: jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET) };
}

module.exports = { createApp, startApp, createUser };
