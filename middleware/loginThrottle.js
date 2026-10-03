const crypto = require("node:crypto");
const LoginThrottle = require("../models/LoginThrottle");

// Brute-force protection for POST /api/auth/login, stored in MongoDB so a
// restart or a second instance never resets a lockout.
//
// - Account rule (IP + email): ACCOUNT_MAX_FAILURES failed attempts within
//   ACCOUNT_WINDOW_MS block that email from that IP for ACCOUNT_BLOCK_MS.
//   Keying on IP + email means one attacked account never locks out the
//   other cashiers who share the shop's public IP.
// - IP rule: IP_MAX_FAILURES failed attempts within IP_WINDOW_MS, whatever
//   the email, block the IP for IP_BLOCK_MS (stops username spraying).
// Only failures count; a successful login clears that account's counter.
// The 429 answer never reveals how long the block lasts (no Retry-After or
// RateLimit-* headers, generic body).
const ACCOUNT_MAX_FAILURES = 5;
const ACCOUNT_WINDOW_MS = 60 * 1000;
const ACCOUNT_BLOCK_MS = 2 * 60 * 60 * 1000;
const IP_MAX_FAILURES = 40;
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_BLOCK_MS = 15 * 60 * 1000;

const TOO_MANY = { message: "Too many attempts. Please try again later." };

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const normalizeEmail = (email) => String(email || "").trim().toLowerCase().slice(0, 254);
const accountKey = (ip, email) => `account:${hash(`${ip}|${normalizeEmail(email)}`)}`;
const ipKey = (ip) => `ip:${hash(String(ip))}`;

async function isBlocked(key, now) {
  const row = await LoginThrottle.findOne({ key }).select("blockedUntil").lean();
  return Boolean(row?.blockedUntil && row.blockedUntil > now);
}

// Atomically counts one failure in a fixed window; starts a new window when
// the previous one has elapsed, and sets blockedUntil when the limit is hit.
async function countFailure({ key, kind, email, windowMs, maxFailures, blockMs, now }) {
  const windowCutoff = new Date(now.getTime() - windowMs);
  const expired = { $lt: [{ $ifNull: ["$windowStart", new Date(0)] }, windowCutoff] };
  const row = await LoginThrottle.findOneAndUpdate(
    { key },
    [{
      $set: {
        kind,
        ...(email ? { email } : {}),
        count: { $cond: [expired, 1, { $add: [{ $ifNull: ["$count", 0] }, 1] }] },
        windowStart: { $cond: [expired, now, "$windowStart"] },
        expiresAt: new Date(now.getTime() + Math.max(windowMs, blockMs) + 60 * 1000),
      },
    }],
    { upsert: true, new: true }
  );
  if (row.count >= maxFailures && !(row.blockedUntil > now)) {
    await LoginThrottle.updateOne({ key }, { $set: { blockedUntil: new Date(now.getTime() + blockMs), expiresAt: new Date(now.getTime() + blockMs + 60 * 1000) } });
    return true;
  }
  return false;
}

/** Rejects a login attempt from a blocked IP or IP+email pair with 429. */
async function loginThrottleGuard(req, res, next) {
  try {
    const now = new Date();
    const email = normalizeEmail(req.body?.email);
    if (await isBlocked(ipKey(req.ip), now) || (email && await isBlocked(accountKey(req.ip, email), now))) {
      req.loginThrottled = true;
      return res.status(429).json(TOO_MANY);
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

/** Counts a failed attempt; returns which lockouts this failure triggered. */
async function recordLoginFailure(req, email) {
  const now = new Date();
  const normalized = normalizeEmail(email);
  const accountLocked = normalized
    ? await countFailure({ key: accountKey(req.ip, normalized), kind: "account", email: normalized, windowMs: ACCOUNT_WINDOW_MS, maxFailures: ACCOUNT_MAX_FAILURES, blockMs: ACCOUNT_BLOCK_MS, now })
    : false;
  const ipLocked = await countFailure({ key: ipKey(req.ip), kind: "ip", windowMs: IP_WINDOW_MS, maxFailures: IP_MAX_FAILURES, blockMs: IP_BLOCK_MS, now });
  return { accountLocked, ipLocked };
}

/** A successful login resets that account's counter from this IP. */
async function recordLoginSuccess(req, email) {
  await LoginThrottle.deleteOne({ key: accountKey(req.ip, normalizeEmail(email)) });
}

/** Admin unlock: clears every account lock for an email, from any IP. */
async function clearAccountLocks(email) {
  const result = await LoginThrottle.deleteMany({ kind: "account", email: normalizeEmail(email) });
  return result.deletedCount || 0;
}

module.exports = {
  ACCOUNT_BLOCK_MS,
  ACCOUNT_MAX_FAILURES,
  IP_MAX_FAILURES,
  TOO_MANY,
  clearAccountLocks,
  loginThrottleGuard,
  recordLoginFailure,
  recordLoginSuccess,
};
