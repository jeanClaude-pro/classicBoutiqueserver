const mongoose = require("mongoose");

// Request-layer validation helpers shared by the routers. They only reject or
// normalize untrusted input; stored records are never re-validated with them.

const MAX_SEARCH_LENGTH = 100;

/** Escapes every regex metacharacter so user text is matched literally. */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A case-insensitive literal-match filter for a search box, or null when the
 * value is empty or not a plain string (arrays from repeated query keys).
 */
function literalSearchRegex(value, maxLength = MAX_SEARCH_LENGTH) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, maxLength);
  if (!trimmed) return null;
  return { $regex: escapeRegex(trimmed), $options: "i" };
}

/** Trimmed string capped at maxLength; non-strings become "". */
function boundedString(value, maxLength) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().slice(0, maxLength);
}

const isObjectId = (value) => typeof value === "string" ? mongoose.isObjectIdOrHexString(value) : value instanceof mongoose.Types.ObjectId;

module.exports = { MAX_SEARCH_LENGTH, boundedString, escapeRegex, isObjectId, literalSearchRegex };
