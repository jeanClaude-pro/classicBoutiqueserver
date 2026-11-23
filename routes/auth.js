// routes/auth.js
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const RevokedToken = require("../models/RevokedToken");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const generateToken = require("../utils/generateToken");
const { JWT_ALGORITHM } = require("../utils/generateToken");
const authMiddleware = require("../middleware/auth");
const { loginThrottleGuard, recordLoginFailure, recordLoginSuccess } = require("../middleware/loginThrottle");
const { recordAudit } = require("../services/auditLog");
const { issueReauthToken } = require("../middleware/reauth");
const { SESSION_COOKIE, clearSessionCookies, readCookie, setReauthCookie, setSessionCookie } = require("../utils/sessionCookies");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVALID_CREDENTIALS = { message: "Invalid email or password" };

// Constant-cost comparison target for unknown emails, so response time does
// not reveal whether an account exists.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 10);

function safeUser(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    role: user.role,
    assignedCategory: user.assignedCategory,
    isActive: user.isActive,
    permissions: user.permissions || [],
    actionPermissions: user.actionPermissions || [],
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/**
 * Revokes the session carried by a cookie (if it is a valid token of ours).
 * Returns its decoded payload, or null. Never throws for a bad token.
 */
async function revokeSessionToken(token) {
  if (!token) return null;
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
  } catch {
    return null;
  }
  if (!decoded?.jti || !decoded?.exp) return null;
  await RevokedToken.updateOne(
    { jti: decoded.jti },
    { $setOnInsert: { jti: decoded.jti, userId: decoded.id, expiresAt: new Date(decoded.exp * 1000) } },
    { upsert: true }
  );
  return decoded;
}

// There is no public sign-up: accounts are created by a superadministrator
// in Administration (POST /api/users). /api/auth/register no longer exists.

router.post("/login", loginThrottleGuard, async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  try {
    if (!email || !password || email.length > 254 || password.length > 128 || !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ message: "Missing credentials" });
    }

    const user = await User.findOne({ email }).select("+password +tokenVersion");
    // Unknown email and wrong password are indistinguishable to the caller.
    const ok = await bcrypt.compare(password, user?.password || DUMMY_HASH);
    if (!user || !ok) {
      const { accountLocked, ipLocked } = await recordLoginFailure(req, email);
      await recordAudit({ req, actor: user || { username: email }, action: "LOGIN_FAILED", outcome: "failure", targetType: "User", targetId: user?._id, details: { email } });
      if (accountLocked || ipLocked) {
        await recordAudit({ req, actor: user || { username: email }, action: "LOGIN_LOCKOUT", outcome: "failure", targetType: "User", targetId: user?._id, details: { email, scope: accountLocked ? "account" : "ip" } });
      }
      return res.status(401).json(INVALID_CREDENTIALS);
    }

    // Only someone who knows the password learns that the account is inactive.
    if (!user.isActive) {
      await recordAudit({ req, actor: user, action: "LOGIN_REFUSED_DISABLED", outcome: "failure", targetType: "User", targetId: user._id });
      return res.status(403).json({ code: "ACCOUNT_DISABLED", message: "Votre compte est désactivé ou en attente d'activation. Contactez un administrateur." });
    }

    await recordLoginSuccess(req, email);
    const token = generateToken(user);
    const { exp } = jwt.decode(token);
    // A session this browser still carried (for example a sign-out made
    // while offline) is revoked: one browser, one live session.
    await revokeSessionToken(readCookie(req, SESSION_COOKIE)).catch(() => null);
    // The token goes into an httpOnly cookie only: it is never part of the
    // response body, so the page's JavaScript never holds it.
    clearSessionCookies(res);
    setSessionCookie(res, token, exp * 1000);
    // Who opened a session, when and from where: needed to attribute every
    // later transaction on a shared till.
    await recordAudit({ req, actor: user, action: "LOGIN_SUCCESS", targetType: "User", targetId: user._id });
    return res.status(200).json({ user: safeUser(user), expiresAt: new Date(exp * 1000).toISOString() });
  } catch (error) {
    console.error("Error logging in user:", error?.name || "Error");
    return res.status(500).json({ message: "Internal server error" });
  }
});

// The client never trusts the user profile it stored at sign-in: at start-up
// (and after a reconnection) it asks the server who this session belongs to.
// authMiddleware has already refused an expired, revoked or disabled session.
router.get("/session", authMiddleware, (req, res) => {
  res.set("Cache-Control", "no-store");
  return res.json({ user: safeUser(req.user), expiresAt: req.auth?.exp ? new Date(req.auth.exp * 1000).toISOString() : null });
});

// Password confirmation for sensitive screens (reports). It never opens a new
// session: it returns a 15-minute proof bound to the current session only.
// Wrong passwords count toward the same lockout as the login form.
const reauthThrottle = (req, _res, next) => { req.throttleEmail = req.user?.email; next(); };
router.post("/reauth", authMiddleware, reauthThrottle, loginThrottleGuard, async (req, res) => {
  try {
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!password || password.length > 128) return res.status(400).json({ message: "Missing credentials" });
    const user = await User.findById(req.user._id).select("+password +tokenVersion");
    const ok = Boolean(user) && await bcrypt.compare(password, user.password || DUMMY_HASH);
    if (!ok) {
      const { accountLocked } = await recordLoginFailure(req, req.user.email);
      await recordAudit({ req, action: "REAUTH_FAILED", outcome: "failure", targetType: "User", targetId: req.user._id, details: { locked: accountLocked } });
      return res.status(403).json({ error: "REAUTH_INVALID", code: "REAUTH_INVALID", message: "Mot de passe incorrect" });
    }
    await recordLoginSuccess(req, req.user.email);
    await recordAudit({ req, action: "REAUTH_SUCCESS", targetType: "User", targetId: req.user._id });
    const proof = issueReauthToken(user, req.auth);
    setReauthCookie(res, proof.reauthToken, proof.expiresAtMs);
    // Only the expiry is returned; the proof itself stays in the cookie.
    return res.json({ confirmed: true, expiresAt: proof.expiresAt });
  } catch (error) {
    console.error("Error confirming password:", error?.name || "Error");
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Ends this session server-side: the token's id is revoked until it expires,
// and the browser's cookies are erased. Always succeeds, even for a session
// that already expired, so a sign-out can never leave a cookie behind.
router.post("/logout", async (req, res) => {
  try {
    // Expired or invalid token: nothing to revoke.
    const decoded = await revokeSessionToken(readCookie(req, SESSION_COOKIE));
    if (decoded) {
      const user = await User.findById(decoded.id).select("username email role");
      await recordAudit({ req, actor: user || undefined, action: "LOGOUT", targetType: "User", targetId: decoded.id });
    }
  } catch (error) {
    // A database error is logged; the cookie is still erased below.
    console.error("Error logging out:", error?.name || "Error");
  }
  clearSessionCookies(res);
  return res.json({ success: true });
});

module.exports = router;
