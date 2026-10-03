const jwt = require("jsonwebtoken");
const User = require("../models/User");
const RevokedToken = require("../models/RevokedToken");
const { JWT_ALGORITHM } = require("../utils/generateToken");

const unauthorized = (res, code, message = "Authentication required") =>
  res.status(401).json(code ? { code, message } : { message });

// Every protected request re-reads the user: a deleted, deactivated or
// demoted account loses access on its next request, and a token issued before
// a role change or deactivation (older tokenVersion) or revoked at logout
// (jti) is refused even though it has not expired.
async function authMiddleware(req, res, next) {
  // Routers repeat this middleware after index.js already ran it; the first
  // successful check for this request is authoritative.
  if (req.authenticatedUser && req.user === req.authenticatedUser) return next();
  const authHeader = req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return unauthorized(res);

  const token = authHeader.slice(7).trim();
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
  } catch (err) {
    console.warn("Authentication rejected:", err.name);
    return unauthorized(res);
  }

  try {
    if (!decoded || typeof decoded.id !== "string") return unauthorized(res);
    const user = await User.findById(decoded.id).select("+tokenVersion");
    if (!user) return unauthorized(res);
    if (!user.isActive) {
      return unauthorized(res, "ACCOUNT_DISABLED", "Votre compte est désactivé ou en attente d'activation. Contactez un administrateur.");
    }
    if (Number(decoded.tv || 0) !== Number(user.tokenVersion || 0)) return unauthorized(res, "SESSION_REVOKED");
    if (decoded.jti && await RevokedToken.exists({ jti: decoded.jti })) return unauthorized(res, "SESSION_REVOKED");

    req.user = user;
    req.auth = { jti: decoded.jti, exp: decoded.exp };
    req.user.canValidate = user.role === "superadmin" || user.role === "manager";
    req.user.isAdmin = user.role === "superadmin";
    req.user.isSuperAdmin = user.role === "superadmin";
    req.user.id = user._id.toString();
    req.user.userId = user._id.toString();
    req.authenticatedUser = user;
    return next();
  } catch (err) {
    if (err?.name === "CastError") return unauthorized(res);
    return next(err);
  }
}

module.exports = authMiddleware;
