// Session and reports-confirmation cookies.
//
// The session token never reaches JavaScript: it lives in an httpOnly cookie
// that the browser sends by itself to /api. The site and the API share one
// origin (Netlify forwards /api/* to this server, see client/netlify.toml), so
// the cookie is first-party and SameSite=Strict, which also keeps other
// websites from using a signed-in browser (CSRF).
const SESSION_COOKIE = "cb_session";
const REAUTH_COOKIE = "cb_reauth";

const isProduction = () => process.env.NODE_ENV === "production";

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    // Always Secure in production; plain http only on a developer machine.
    secure: isProduction() || process.env.COOKIE_SECURE === "true",
    sameSite: "strict",
    path: "/api",
    ...(maxAgeMs === undefined ? {} : { maxAge: Math.max(0, Math.floor(maxAgeMs)) }),
  };
}

/** Minimal Cookie header parser (no dependency); ignores malformed pairs. */
function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header || typeof header !== "string" || header.length > 8192) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function setSessionCookie(res, token, expiresAtMs) {
  res.cookie(SESSION_COOKIE, token, cookieOptions(expiresAtMs - Date.now()));
}

function setReauthCookie(res, token, expiresAtMs) {
  res.cookie(REAUTH_COOKIE, token, cookieOptions(expiresAtMs - Date.now()));
}

function clearSessionCookies(res) {
  const options = cookieOptions();
  res.clearCookie(SESSION_COOKIE, options);
  res.clearCookie(REAUTH_COOKIE, options);
}

module.exports = {
  REAUTH_COOKIE,
  SESSION_COOKIE,
  clearSessionCookies,
  cookieOptions,
  readCookie,
  setReauthCookie,
  setSessionCookie,
};
