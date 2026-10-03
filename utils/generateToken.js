const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const JWT_ALGORITHM = "HS256";
const DEFAULT_EXPIRY = "12h";

/**
 * Signs a session token for a user. `tv` binds the token to the user's
 * tokenVersion (bumped on role change or deactivation) and `jti` lets a
 * single session be revoked at logout.
 */
const generateToken = (user) => {
  const payload = {
    id: String(user._id ?? user.id),
    tv: Number(user.tokenVersion || 0),
    jti: crypto.randomUUID(),
  };
  return jwt.sign(payload, process.env.JWT_SECRET, {
    algorithm: JWT_ALGORITHM,
    expiresIn: process.env.JWT_EXPIRES_IN || DEFAULT_EXPIRY,
  });
};

module.exports = generateToken;
module.exports.JWT_ALGORITHM = JWT_ALGORITHM;
