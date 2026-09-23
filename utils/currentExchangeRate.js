const ExchangeRate = require("../models/ExchangeRate");

// A transaction entered in USD still needs an exchangeRate snapshot so it can
// later be displayed in FC without ever reaching for *today's* rate (which
// would violate the "historical transactions stay stable" rule). This looks
// up the rate in effect right now, to be used only as a fallback when the
// caller didn't send an explicit exchangeRate with the request.
async function getFallbackExchangeRate() {
  const current = await ExchangeRate.getCurrentRate();
  return current ? current.rate : undefined;
}

module.exports = { getFallbackExchangeRate };
