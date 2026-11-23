// Unit tests (no database): the reports password confirmation proof and the
// development-only guard on diagnostic endpoints.
process.env.JWT_SECRET = process.env.JWT_SECRET || "unit-test-secret-that-is-long-enough-123";
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { hasValidReauth, issueReauthToken, requireReportsReauth } = require("../middleware/reauth");
const { developmentOnly } = require("../middleware/security");

const user = (role = "superadmin", tokenVersion = 0) => ({ _id: "64b000000000000000000001", role, tokenVersion });
// The proof travels in the httpOnly cb_reauth cookie.
const request = (u, jti, proof) => ({ user: u, auth: { jti }, headers: proof ? { cookie: `cb_reauth=${encodeURIComponent(proof)}` } : {} });
function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test("a proof is valid only for the user, session and token version it was issued for", () => {
  const owner = user();
  const { reauthToken, expiresAt } = issueReauthToken(owner, { jti: "session-a" });
  assert.ok(new Date(expiresAt).getTime() > Date.now());
  assert.equal(hasValidReauth(request(owner, "session-a", reauthToken)), true);
  assert.equal(hasValidReauth(request(owner, "session-b", reauthToken)), false, "another session of the same user");
  assert.equal(hasValidReauth(request({ ...owner, _id: "64b000000000000000000002" }, "session-a", reauthToken)), false, "another user");
  assert.equal(hasValidReauth(request(user("superadmin", 1), "session-a", reauthToken)), false, "role change / deactivation bumped the token version");
  assert.equal(hasValidReauth(request(owner, "session-a", undefined)), false);
});

test("a session token or a forged / expired proof is never accepted as a proof", () => {
  const owner = user();
  const sessionToken = jwt.sign({ id: owner._id, jti: "session-a" }, process.env.JWT_SECRET);
  assert.equal(hasValidReauth(request(owner, "session-a", sessionToken)), false, "wrong audience");
  const forged = jwt.sign({ sub: owner._id, sid: "session-a", tv: 0, purpose: "reports" }, "another-secret-that-is-long-enough-xx", { audience: "classic-boutique:reauth" });
  assert.equal(hasValidReauth(request(owner, "session-a", forged)), false, "wrong signature");
  const expired = jwt.sign({ sub: owner._id, sid: "session-a", tv: 0, purpose: "reports", exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET, { audience: "classic-boutique:reauth" });
  assert.equal(hasValidReauth(request(owner, "session-a", expired)), false, "expired");
  const unsigned = jwt.sign({ sub: owner._id, sid: "session-a", tv: 0, purpose: "reports" }, "", { algorithm: "none", audience: "classic-boutique:reauth" });
  assert.equal(hasValidReauth(request(owner, "session-a", unsigned)), false, "alg none");
});

test("the reports guard asks only the superadmin for a confirmation", () => {
  let passed = 0;
  const next = () => { passed += 1; };
  const refused = response();
  requireReportsReauth(request(user(), "s", undefined), refused, next);
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.body.code, "REAUTH_REQUIRED");
  assert.equal(passed, 0);

  const owner = user();
  requireReportsReauth(request(owner, "s", issueReauthToken(owner, { jti: "s" }).reauthToken), response(), next);
  assert.equal(passed, 1);
  // Shareholders keep the existing behaviour (no password screen).
  requireReportsReauth(request(user("admin"), "s", undefined), response(), next);
  assert.equal(passed, 2);
});

test("diagnostic endpoints do not exist in production", () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    const res = response();
    let called = false;
    developmentOnly({}, res, () => { called = true; });
    assert.equal(res.statusCode, 404);
    assert.equal(called, false);
    process.env.NODE_ENV = "development";
    developmentOnly({}, response(), () => { called = true; });
    assert.equal(called, true);
  } finally {
    process.env.NODE_ENV = previous;
  }
});
