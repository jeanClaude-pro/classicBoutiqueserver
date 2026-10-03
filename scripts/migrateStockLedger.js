require("dotenv").config();
const mongoose = require("mongoose");
const { ensureStockBaselines } = require("../services/stockMovementService");

async function run() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI);
  const count = await ensureStockBaselines();
  console.log(`Created ${count} stock-ledger baseline(s)`);
  await mongoose.disconnect();
}

if (require.main === module) run().catch((error) => { console.error(error.message); process.exit(1); });
module.exports = { run };
