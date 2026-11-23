const jwt = require("jsonwebtoken");

// Only the shop's own site may talk to this API.
//
// 1. Netlify signature (production). The site forwards /api/* to this server
//    and signs every forwarded request with PROXY_SIGNING_SECRET (Netlify
//    "signed proxy redirect", header x-nf-sign). A request that did not come
//    through the shop's site - a script calling the Render address directly -
//    has no valid signature and is refused before any route runs.
// 2. Origin. A browser request must come from CLIENT_URL: any other Origin,
//    a cross-site fetch (Sec-Fetch-Site: cross-site) or a state-changing
//    request without Origin/Referer is refused.
//
// Note: a program can always forge headers such as Origin; that is why the
// signature (secret, never in the browser or the repository) and the httpOnly
// session cookie are what really protect the API.

const SIGNATURE_HEADER = "x-nf-sign";
const CLIENT_IP_HEADER = "x-nf-client-connection-ip";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const normalizeOrigin = (value) => String(value || "").trim().replace(/\/+$/, "").toLowerCase();

function configuredOrigins({ isProduction = process.env.NODE_ENV === "production" } = {}) {
  const configured = String(process.env.CLIENT_URL || "").split(",").map(normalizeOrigin).filter(Boolean);
  const development = ["http://localhost:5173", "http://127.0.0.1:5173"];
  return new Set(isProduction ? configured : [...development, ...configured]);
}

function originOfReferer(referer) {
  try {
    return normalizeOrigin(new URL(referer).origin);
  } catch {
    return "";
  }
}

/** True when `x-nf-sign` is a valid Netlify signature made with `secret`. */
function hasValidNetlifySignature(req, secret) {
  const signature = req.get(SIGNATURE_HEADER);
  if (!signature || signature.length > 4096 || !secret) return false;
  try {
    const claims = jwt.verify(signature, secret, { algorithms: ["HS256"], issuer: "netlify" });
    return Boolean(claims && typeof claims === "object");
  } catch {
    return false;
  }
}

/** Express middleware for /api. `allowUnsigned` lists paths a platform health check calls directly. */
function trustedClientOnly({ allowedOrigins = configuredOrigins(), signingSecret = process.env.PROXY_SIGNING_SECRET, allowUnsigned = ["/health"] } = {}) {
  return function trustedClient(req, res, next) {
    if (signingSecret && !allowUnsigned.includes(req.path)) {
      if (!hasValidNetlifySignature(req, signingSecret)) {
        // Indistinguishable from a route that does not exist.
        return res.status(404).json({ message: "Not found" });
      }
      // Behind the verified proxy, the real visitor IP (used by login
      // throttling and rate limits) is the one Netlify reports.
      const clientIp = String(req.get(CLIENT_IP_HEADER) || "").trim();
      if (clientIp && clientIp.length <= 64) {
        Object.defineProperty(req, "ip", { value: clientIp, configurable: true });
      }
    }

    const origin = normalizeOrigin(req.get("origin"));
    if (origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ message: "Origin not allowed" });
    }
    if (String(req.get("sec-fetch-site") || "").toLowerCase() === "cross-site") {
      return res.status(403).json({ message: "Origin not allowed" });
    }
    if (!SAFE_METHODS.has(req.method)) {
      const source = origin || originOfReferer(req.get("referer"));
      if (!source || !allowedOrigins.has(source)) {
        return res.status(403).json({ message: "Origin not allowed" });
      }
    }
    return next();
  };
}

module.exports = {
  CLIENT_IP_HEADER,
  SIGNATURE_HEADER,
  configuredOrigins,
  hasValidNetlifySignature,
  normalizeOrigin,
  trustedClientOnly,
};
