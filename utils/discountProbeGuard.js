// Limits how cheaply a cashier can discover the protected discount floor by
// submitting ever lower prices: each PRICE_TOO_LOW refusal answers "above or
// below the floor", so repeated refusals amount to a binary search.
//
// After MAX_REJECTIONS refusals within WINDOW_MS, every reduced price from
// that user is refused with DISCOUNT_ATTEMPTS_LIMITED until the oldest
// refusal leaves the window. While limited the answer no longer depends on
// the floor, so further attempts reveal nothing. Prices at or above the
// normal price are never affected: ordinary selling continues.
//
// State is in memory (per server process); a restart clears it. Roles that
// can already read acquisition costs are never limited.
const WINDOW_MS = 30 * 60 * 1000;
const MAX_REJECTIONS = 8;

function createDiscountProbeGuard({ windowMs = WINDOW_MS, maxRejections = MAX_REJECTIONS, now = () => Date.now() } = {}) {
  const rejections = new Map();

  const recent = (userKey) => {
    const cutoff = now() - windowMs;
    const kept = (rejections.get(userKey) || []).filter((at) => at > cutoff);
    if (kept.length) rejections.set(userKey, kept);
    else rejections.delete(userKey);
    return kept;
  };

  return {
    /** Records one PRICE_TOO_LOW refusal; true when this one reaches the limit. */
    recordRejection(userKey) {
      if (!userKey) return false;
      const kept = recent(userKey);
      kept.push(now());
      rejections.set(userKey, kept);
      return kept.length === maxRejections;
    },
    isLimited(userKey) {
      return Boolean(userKey) && recent(userKey).length >= maxRejections;
    },
    reset() {
      rejections.clear();
    },
  };
}

const discountProbeGuard = createDiscountProbeGuard();

module.exports = { WINDOW_MS, MAX_REJECTIONS, createDiscountProbeGuard, discountProbeGuard };
