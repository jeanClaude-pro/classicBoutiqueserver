// Unit tests (no database): only the shop's site may call the API, and the
// session lives in an httpOnly cookie.
process.env.JWT_SECRET = process.env.JWT_SECRET || "unit-test-secret-that-is-long-enough-123";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const { trustedClientOnly } = require("../middleware/trustedClient");
const { cookieOptions, readCookie } = require("../utils/sessionCookies");

const SECRET = "netlify-proxy-signing-secret-long-enough-0123456789";
const SITE = "https://boutique.example";
const allowedOrigins = new Set([SITE]);

function request({ method = "GET", path: reqPath = "/sales", headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { method, path: reqPath, headers: lower, ip: "10.0.0.1", get: (name) => lower[name.toLowerCase()] };
}
function run(guard, req) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json() { return this; } };
  let passed = false;
  guard(req, res, () => { passed = true; });
  return { passed, status: passed ? 200 : res.statusCode };
}
const signature = (secret = SECRET, claims = {}) => jwt.sign({ iss: "netlify", deploy_context: "production", site_url: SITE, ...claims }, secret, { algorithm: "HS256", expiresIn: 60 });

test("with a signing secret, only requests signed by the Netlify proxy are answered", () => {
  const guard = trustedClientOnly({ allowedOrigins, signingSecret: SECRET });
  assert.equal(run(guard, request()).status, 404, "direct call to the API address");
  assert.equal(run(guard, request({ headers: { "x-nf-sign": signature("wrong-secret-that-is-long-enough-xxxxxxxxxx") } })).status, 404, "forged signature");
  assert.equal(run(guard, request({ headers: { "x-nf-sign": jwt.sign({ iss: "netlify" }, "", { algorithm: "none" }) } })).status, 404, "unsigned (alg none)");
  assert.equal(run(guard, request({ headers: { "x-nf-sign": signature(SECRET, { iss: "someone" }) } })).status, 404, "wrong issuer");
  const expired = jwt.sign({ iss: "netlify", exp: Math.floor(Date.now() / 1000) - 60 }, SECRET, { algorithm: "HS256" });
  assert.equal(run(guard, request({ headers: { "x-nf-sign": expired } })).status, 404, "expired signature");
  assert.equal(run(guard, request({ headers: { "x-nf-sign": signature() } })).passed, true);
  // The platform health check reaches /health directly.
  assert.equal(run(guard, request({ path: "/health" })).passed, true);
});

test("behind the verified proxy, the visitor's real IP is used (login throttling)", () => {
  const guard = trustedClientOnly({ allowedOrigins, signingSecret: SECRET });
  const req = request({ headers: { "x-nf-sign": signature(), "x-nf-client-connection-ip": "41.243.1.2" } });
  assert.equal(run(guard, req).passed, true);
  assert.equal(req.ip, "41.243.1.2");
  // Without a valid signature the header is never trusted.
  const spoofed = request({ headers: { "x-nf-client-connection-ip": "1.2.3.4" } });
  run(trustedClientOnly({ allowedOrigins, signingSecret: SECRET }), spoofed);
  assert.equal(spoofed.ip, "10.0.0.1");
});

test("browser requests must come from CLIENT_URL", () => {
  const guard = trustedClientOnly({ allowedOrigins, signingSecret: "" });
  assert.equal(run(guard, request({ headers: { origin: "https://evil.example" } })).status, 403, "foreign origin");
  assert.equal(run(guard, request({ headers: { "sec-fetch-site": "cross-site" } })).status, 403, "cross-site fetch");
  assert.equal(run(guard, request({ method: "POST" })).status, 403, "state change without Origin");
  assert.equal(run(guard, request({ method: "POST", headers: { referer: "https://evil.example/login" } })).status, 403);
  assert.equal(run(guard, request({ method: "POST", headers: { origin: SITE } })).passed, true);
  assert.equal(run(guard, request({ method: "POST", headers: { referer: `${SITE}/login` } })).passed, true);
  assert.equal(run(guard, request({ headers: { "sec-fetch-site": "same-origin" } })).passed, true, "same-origin GET (no Origin header)");
  assert.equal(run(guard, request({ method: "POST", headers: { origin: `${SITE.toUpperCase()}/` } })).passed, true, "origin compared case-insensitively");
});

test("session cookies are httpOnly, SameSite=Strict, limited to /api, Secure in production", () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.deepEqual(cookieOptions(1000), { httpOnly: true, secure: true, sameSite: "strict", path: "/api", maxAge: 1000 });
    process.env.NODE_ENV = "development";
    assert.equal(cookieOptions(1000).secure, false);
  } finally {
    process.env.NODE_ENV = previous;
  }
  assert.equal(readCookie({ headers: { cookie: "a=1; cb_session=abc%2Edef; b=2" } }, "cb_session"), "abc.def");
  assert.equal(readCookie({ headers: { cookie: "xcb_session=no" } }, "cb_session"), null);
  assert.equal(readCookie({ headers: {} }, "cb_session"), null);
});

test("the session is never read from an Authorization header and never sent in a body", () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  assert.doesNotMatch(read("middleware/auth.js"), /Authorization|Bearer/);
  assert.doesNotMatch(read("routes/auth.js"), /json\(\{[^}]*\btoken\b/);
  assert.doesNotMatch(read("routes/auth.js"), /router\.post\("\/register"/, "no public sign-up");
});
