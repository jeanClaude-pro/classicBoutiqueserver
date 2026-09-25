require("dotenv").config();
const mongoose = require("mongoose");
const ShopSettings = require("../models/ShopSettings");

// The company's phone number changed. Receipts print the number stored in
// ShopSettings, so the stored record is updated too — but only when it still
// holds the old number, never over a number set by hand in the admin panel.
const OLD_NUMBER = "+243 836 017 031";
const NEW_NUMBER = "+243 975 085 799";

async function updateShopNumber() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required");
  }

  await mongoose.connect(process.env.MONGO_URI);
  const result = await ShopSettings.updateMany(
    { shopNumber: OLD_NUMBER },
    { $set: { shopNumber: NEW_NUMBER } }
  );
  const current = await ShopSettings.findOne().lean();

  console.log(
    `Updated ${result.modifiedCount} shop settings record(s). Stored number: ${current?.shopNumber ?? "(no record yet; the default " + NEW_NUMBER + " applies)"}.`
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
