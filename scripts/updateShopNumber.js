require("dotenv").config();
const mongoose = require("mongoose");
const ShopSettings = require("../models/ShopSettings");
const { COMPANY_PHONE } = require("../utils/company");

// Align every existing ShopSettings record with the canonical receipt number.

async function updateShopNumber() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required");
  }

  await mongoose.connect(process.env.MONGO_URI);
  const result = await ShopSettings.updateMany(
    { shopNumber: { $ne: COMPANY_PHONE } },
    { $set: { shopNumber: COMPANY_PHONE } }
  );
  const current = await ShopSettings.findOne().lean();

  console.log(
    `Updated ${result.modifiedCount} shop settings record(s). Stored number: ${current?.shopNumber ?? "(no record yet; the default " + COMPANY_PHONE + " applies)"}.`
  );
}

updateShopNumber()
  .catch((error) => {
    console.error("Shop number update failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
