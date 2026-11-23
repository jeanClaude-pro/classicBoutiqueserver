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
const { requireModuleAccess } = require("../../middleware/moduleAccess");
const User = require("../../models/User");
const { productStockSheet, stockSheet, salesSheet } = require("../../routes/operationalReports");
const { issueReauthToken, requireReportsReauth } = require("../../middleware/reauth");
const { trustedClientOnly } = require("../../middleware/trustedClient");
const { REAUTH_COOKIE, SESSION_COOKIE } = require("../../utils/sessionCookies");

// The browser origin every test request comes from (allowed outside production).
const TEST_ORIGIN = "http://localhost:5173";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(preventNoSqlInjection);
  app.use("/api", trustedClientOnly());
  const guarded = (modules, categorySensitive = false) => [
    authMiddleware,
    requireShareholderModule(...modules),
    ...(categorySensitive ? [requireAssignedCategory] : []),
    blockShareholderMutations,
  ];
  app.get("/api/products/stock-sheet", ...guarded([MODULES.PRODUCTS], true), requireModuleAccess("/products"), stockSheet);
  app.get("/api/products/:id/stock-sheet", ...guarded([MODULES.PRODUCTS], true), requireModuleAccess("/products"), productStockSheet);
  app.get("/api/analytics/sales-sheet", ...guarded([MODULES.REPORTS], true), requireModuleAccess("/reports"), requireReportsReauth, salesSheet);
  app.use("/api/products", ...guarded([MODULES.PRODUCTS], true), require("../../routes/products"));
  app.use("/api/sales", ...guarded([MODULES.SALES_HISTORY], true), require("../../routes/sales"));
  app.use("/api/expenses", ...guarded([MODULES.EXPENSES]), require("../../routes/expenses"));
  app.use("/api/entries", ...guarded([MODULES.ENTRIES]), require("../../routes/entries"));
  app.use("/api/analytics", ...guarded([MODULES.REPORTS], true), requireReportsReauth, require("../../routes/analytics"));
  app.use("/api/customers", ...guarded([MODULES.CUSTOMERS]), require("../../routes/customers"));
  app.use("/api/users", require("../../routes/users"));
  app.use("/api/auth", require("../../routes/auth"));
  app.use("/api/audit-logs", require("../../routes/auditLogs"));
  app.use("/api/settings", ...guarded([MODULES.REPORTS, MODULES.SALES_HISTORY]), require("../../routes/settings"));
  // Retired with the FC-only cutover (same answer as index.js).
  app.use("/api/exchange-rates", (_req, res) => res.status(410).json({ error: "EXCHANGE_RATES_RETIRED" }));
  app.use("/api/creditors", ...guarded([MODULES.DEBTS]), require("../../routes/creditors"));
  return app;
}

/** A valid reports confirmation proof for the session carried by `token`. */
function reauthProofFor(token) {
  const decoded = jwt.decode(token);
  if (!decoded?.id) return null;
  return issueReauthToken({ _id: decoded.id, tokenVersion: decoded.tv || 0 }, { jti: decoded.jti }).reauthToken;
}

async function startApp() {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return {
    base,
    // The session travels in its httpOnly cookie, exactly like a browser.
    // Reports require a password confirmation proof (cookie) for the
    // superadmin: tests get a valid one by default; pass reauth: false to test
    // the refusal, or a string to send a specific proof. `origin: null` sends
    // no Origin header; `headers` adds or overrides headers.
    async request(method, url, { token, body, reauth = true, origin = TEST_ORIGIN, headers = {} } = {}) {
      const proof = typeof reauth === "string" ? reauth : reauth && token ? reauthProofFor(token) : null;
      const cookies = [
        ...(token ? [`${SESSION_COOKIE}=${encodeURIComponent(token)}`] : []),
        ...(proof ? [`${REAUTH_COOKIE}=${encodeURIComponent(proof)}`] : []),
      ];
      const response = await fetch(`${base}${url}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { Origin: origin } : {}),
          ...(cookies.length ? { Cookie: cookies.join("; ") } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: response.status, body: json, headers: Object.fromEntries(response.headers), setCookies: response.headers.getSetCookie() };
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

/** The session token a login response set in its cookie (null if none). */
function sessionTokenFrom(response) {
  for (const cookie of response.setCookies || []) {
    const match = cookie.match(new RegExp(`^${SESSION_COOKIE}=([^;]*)`));
    if (match && match[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

module.exports = { createApp, startApp, createUser, reauthProofFor, sessionTokenFrom, TEST_ORIGIN };
