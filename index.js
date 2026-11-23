require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const { preventNoSqlInjection } = require("./middleware/security");
const authMiddleware = require("./middleware/auth");
const { ensureAccountingLocks } = require("./services/financialAccountingService");
const { ensureStockBaselines } = require("./services/stockMovementService");
const { repairReversalIndex } = require("./scripts/migrateExpenseAccounting");
const { MODULES, blockShareholderMutations, requireAssignedCategory, requireShareholderModule } = require("./middleware/authorization");
const { requireModuleAccess } = require("./middleware/moduleAccess");
const { productStockSheet, stockSheet, salesSheet } = require("./routes/operationalReports");
const { requireReportsReauth } = require("./middleware/reauth");
const { configuredOrigins, trustedClientOnly } = require("./middleware/trustedClient");
const { rateLimit } = require("express-rate-limit");

const app = express();
const printRoutes = require('./routes/print');

const isProduction = process.env.NODE_ENV === "production";
const requiredSecrets = ["MONGO_URI", "JWT_SECRET"];
const missingSecrets = requiredSecrets.filter((name) => !process.env[name]);
if (missingSecrets.length) {
  console.error(`Server configuration error: missing ${missingSecrets.join(", ")}`);
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32) {
  console.error("Server configuration error: JWT_SECRET must be at least 32 characters");
  process.exit(1);
}
// In production the API only answers requests forwarded (and signed) by the
// shop's Netlify site. The same value is set on Netlify as API_PROXY_SIGNATURE.
if (isProduction && String(process.env.PROXY_SIGNING_SECRET || "").length < 32) {
  console.error("Server configuration error: PROXY_SIGNING_SECRET (at least 32 characters) is required in production");
  process.exit(1);
}

// Middleware
app.disable("x-powered-by");
// Number of reverse-proxy hops in front of the app, so req.ip (used by login
// throttling) is the real client address. Render has exactly one: the default.
// Accepts a hop count or an Express trust-proxy keyword list (e.g. "loopback").
const trustProxy = String(process.env.TRUST_PROXY ?? "1").trim();
app.set("trust proxy", /^[0-9]+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));
app.use((error, _req, res, next) => {
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Invalid JSON request" });
  }
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ message: "Request payload too large" });
  }
  next(error);
});
app.use(morgan("combined"));
app.use(preventNoSqlInjection);

// Allow configured origins with explicit headers so Authorization is preserved.
const allowedOrigins = configuredOrigins({ isProduction });
if (isProduction && allowedOrigins.size === 0) {
  console.error("Server configuration error: CLIENT_URL is required in production");
  process.exit(1);
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin.replace(/\/$/, "").toLowerCase())) return callback(null, true);
    return callback(new Error("Origin not allowed by CORS"));
  },
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept", "X-Requested-With"],
  credentials: false,
  optionsSuccessStatus: 200,
}));

app.use((req, res, next) => {
  if (!isProduction || req.secure || req.get("x-forwarded-proto") === "https") return next();
  if (req.method === "GET" || req.method === "HEAD") {
    return res.redirect(308, `https://${req.get("host")}${req.originalUrl}`);
  }
  return res.status(426).json({ message: "HTTPS required" });
});

// Env variables
const PORT = process.env.PORT || 5000;

function getMongoUri() {
  const uri = process.env.MONGO_URI;
  const parsed = new URL(uri);

  // This network's DNS proxy returns EBADRESP for Atlas SRV queries. Use the
  // equivalent seed list for this cluster so Node does ordinary A/AAAA lookups.
  if (parsed.protocol !== "mongodb+srv:" || parsed.hostname !== "cluster0.dckjabm.mongodb.net") {
    return uri;
  }

  const hosts = [
    "ac-rchorki-shard-00-00.dckjabm.mongodb.net:27017",
    "ac-rchorki-shard-00-01.dckjabm.mongodb.net:27017",
    "ac-rchorki-shard-00-02.dckjabm.mongodb.net:27017",
  ].join(",");
  const params = new URLSearchParams(parsed.searchParams);
  params.set("tls", "true");
  params.set("authSource", "admin");
  params.set("replicaSet", "atlas-9ou3vz-shard-0");

  return `mongodb://${parsed.username}:${parsed.password}@${hosts}${parsed.pathname}?${params}`;
}

const MONGO_URI = getMongoUri();

// API responses carry business and personal data: never cache them.
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Only the shop's site (CLIENT_URL, through the signed Netlify proxy) may call
// the API; see middleware/trustedClient.js. Runs before the rate limits so
// they count the real visitor IP.
app.use("/api", trustedClientOnly({ allowedOrigins }));

// General abuse limit for the whole API (login and sign-up keep their own,
// much stricter limits). Generous enough for several tills sharing the
// shop's public IP; no rate-limit headers, so the window is not revealed.
app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT_PER_MINUTE) || 600,
  standardHeaders: false,
  legacyHeaders: false,
  skip: (req) => req.path === "/health",
  message: { message: "Too many requests. Please try again later." },
}));

const guarded = (modules, categorySensitive = false) => [
  authMiddleware,
  requireShareholderModule(...modules),
  ...(categorySensitive ? [requireAssignedCategory] : []),
  blockShareholderMutations,
];

// ====== Use Routes ======
app.get("/api/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({ ok: connected, database: connected ? "connected" : "unavailable" });
});
app.get("/api/products/stock-sheet", ...guarded([MODULES.PRODUCTS], true), requireModuleAccess("/products"), stockSheet);
app.get("/api/products/:id/stock-sheet", ...guarded([MODULES.PRODUCTS], true), requireModuleAccess("/products"), productStockSheet);
// Superadmin reports require a recent password confirmation (see middleware/reauth.js).
app.get("/api/analytics/sales-sheet", ...guarded([MODULES.REPORTS], true), requireModuleAccess("/reports"), requireReportsReauth, salesSheet);
app.use("/api/products", ...guarded([MODULES.PRODUCTS], true), require("./routes/products"));
app.use("/api/sales", ...guarded([MODULES.SALES_HISTORY], true), require("./routes/sales"));
app.use("/api/customers", ...guarded([MODULES.CUSTOMERS]), require("./routes/customers"));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/categories", ...guarded([MODULES.PRODUCTS]), require("./routes/categories"));
// Printing a receipt belongs to the POS and Sales History pages only.
app.use('/api/print', ...guarded([MODULES.SALES_HISTORY]), requireModuleAccess("/", "/sales"), printRoutes);
app.use("/api/expenses", ...guarded([MODULES.EXPENSES]), require("./routes/expenses"));
// The exchange-rate module was retired with the FC-only cutover. Its route
// answers 410 so a till still running an old interface gets a clear signal.
app.use("/api/exchange-rates", (_req, res) => res.status(410).json({ error: "EXCHANGE_RATES_RETIRED", message: "L'application fonctionne uniquement en francs congolais (FC). Actualisez la page." }));
app.use("/api/entries", ...guarded([MODULES.ENTRIES]), require("./routes/entries"));
app.use("/api/settings", ...guarded([MODULES.REPORTS, MODULES.SALES_HISTORY]), require("./routes/settings"));
app.use("/api/analytics", ...guarded([MODULES.REPORTS], true), requireReportsReauth, require("./routes/analytics"));
app.use("/api/creditors", ...guarded([MODULES.DEBTS]), require("./routes/creditors"));
app.use("/api/audit-logs", require("./routes/auditLogs"));
// Default route: says nothing about the software behind it.
app.get("/", (_req, res) => {
  res.json({ ok: true });
});

// Unknown API routes answer in JSON, never with the framework's HTML page.
app.use("/api", (_req, res) => res.status(404).json({ message: "Not found" }));

app.use((error, _req, res, _next) => {
  if (error?.message === "Origin not allowed by CORS") return res.status(403).json({ message: "Origin not allowed" });
  console.error("Unhandled server error:", error?.name || "Error");
  return res.status(500).json({ message: "Internal server error" });
});

// ====== DB + Server Startup ======
mongoose
  .connect(MONGO_URI)
  .then(async () => {
    await ensureAccountingLocks();
    const stockBaselines = await ensureStockBaselines();
    if (stockBaselines) console.log(`Created ${stockBaselines} stock-ledger baseline(s)`);
    // Mongoose builds new indexes at boot but never drops obsolete ones; the
    // legacy unique+sparse reversalOf_1 rejects every expense after the first.
    try {
      const { droppedBrokenReversalIndex } = await repairReversalIndex();
      if (droppedBrokenReversalIndex) console.log("Dropped obsolete expenses index reversalOf_1");
    } catch (error) {
      console.error("Expense index repair failed:", error.message);
    }
    // FC-only cutover: the catalogue must be converted once (see
    // scripts/migrateToFcOnly.js). Until then products are read through their
    // own FC snapshot, which may differ from the price the till last used.
    try {
      const unconverted = await mongoose.connection.db.collection("products").countDocuments({ currency: { $ne: "FC" } });
      if (unconverted) console.warn(`⚠️  ${unconverted} product(s) not yet converted to FC: run "npm run migrate:fc-only -- --apply"`);
    } catch (error) {
      console.error("FC catalogue check failed:", error.message);
    }
    console.log("✅ Connected to MongoDB Atlas");
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });
