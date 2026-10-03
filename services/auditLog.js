const AuditLog = require("../models/AuditLog");

// Keys never written to the audit trail, at any depth.
const SECRET_KEY_PATTERN = /pass(word)?|token|secret|jti|hash|fingerprint|^tv$|authorization/i;
const MAX_DEPTH = 6;

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return "[truncated]";
  if (value instanceof Date) return value;
  if (typeof value?.toHexString === "function") return value.toHexString();
  if (typeof value?.toObject === "function") return sanitize(value.toObject(), depth);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const clean = {};
    for (const [key, nested] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key) || key === "__v") continue;
      clean[key] = sanitize(nested, depth + 1);
    }
    return clean;
  }
  if (typeof value === "string") return value.slice(0, 2000);
  return value;
}

/**
 * Records one audit entry. Never throws: an audit failure is logged but does
 * not undo or block the business operation that already succeeded. Pass a
 * session to make the entry part of the operation's transaction.
 */
async function recordAudit({ req, actor, action, outcome = "success", targetType, targetId, before, after, details, session } = {}) {
  try {
    const user = actor || req?.user;
    const doc = {
      action,
      outcome,
      actorId: user?._id,
      actorName: user?.username || user?.email,
      actorRole: user?.role,
      targetType,
      targetId: targetId === undefined || targetId === null ? undefined : String(targetId),
      before: sanitize(before),
      after: sanitize(after),
      details: sanitize(details),
      ip: req?.ip,
    };
    await AuditLog.create([doc], session ? { session } : undefined);
  } catch (error) {
    console.error("Audit log write failed:", action, error?.name || "Error");
    if (session) throw error;
  }
}

module.exports = { recordAudit, sanitizeForAudit: sanitize };
