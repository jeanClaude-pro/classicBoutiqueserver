// Escaping for values interpolated into HTML (notification emails).
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** Shallow copy of a record whose string fields are HTML-escaped. */
function htmlSafeRecord(record) {
  const plain = typeof record?.toObject === "function" ? record.toObject() : { ...(record || {}) };
  for (const [key, value] of Object.entries(plain)) {
    if (typeof value === "string") plain[key] = escapeHtml(value);
  }
  return plain;
}

module.exports = { escapeHtml, htmlSafeRecord };
