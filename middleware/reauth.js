const jwt = require("jsonwebtoken");
const { JWT_ALGORITHM } = require("../utils/generateToken");
const { isSuperadmin } = require("./authorization");
const { REAUTH_COOKIE, readCookie } = require("../utils/sessionCookies");

// Step-up confirmation for the most sensitive screens (full financial
// reports). After the superadmin re-enters the password, POST /api/auth/reauth
// issues a short-lived proof bound to that exact session (its jti). The
// reports API refuses a superadmin request without a valid proof, so the
// password screen can no longer be skipped by editing the page in a browser.
// The proof is an httpOnly cookie: page scripts never see it.
const REAUTH_PURPOSE = "reports";
const REAUTH_AUDIENCE = "classic-boutique:reauth";
const REAUTH_TTL_SECONDS = 15 * 60;

function issueReauthToken(user, auth) {
  const token = jwt.sign(
    { sub: String(user._id), sid: auth?.jti || null, tv: Number(user.tokenVersion || 0), purpose: REAUTH_PURPOSE },
    process.env.JWT_SECRET,
    { algorithm: JWT_ALGORITHM, audience: REAUTH_AUDIENCE, expiresIn: REAUTH_TTL_SECONDS },
  );
  const expiresAtMs = Date.now() + REAUTH_TTL_SECONDS * 1000;
  return { reauthToken: token, expiresAtMs, expiresAt: new Date(expiresAtMs).toISOString() };
}

function hasValidReauth(req) {
  const raw = readCookie(req, REAUTH_COOKIE);
  if (!raw || raw.length > 2048) return false;
  try {
    const proof = jwt.verify(raw, process.env.JWT_SECRET, { algorithms: [JWT_ALGORITHM], audience: REAUTH_AUDIENCE });
    return proof.purpose === REAUTH_PURPOSE
      && proof.sub === String(req.user._id)
      && proof.sid === (req.auth?.jti || null)
      && Number(proof.tv || 0) === Number(req.user.tokenVersion || 0);
  } catch {
    return false;
  }
}

/** Superadmin report requests need a recent password confirmation. */
function requireReportsReauth(req, res, next) {
  if (!isSuperadmin(req.user)) return next();
  if (hasValidReauth(req)) return next();
  return res.status(403).json({ error: "REAUTH_REQUIRED", code: "REAUTH_REQUIRED", message: "Confirmez votre mot de passe pour ouvrir les rapports." });
}

module.exports = {
  REAUTH_TTL_SECONDS,
  hasValidReauth,
  issueReauthToken,
  requireReportsReauth,
};
