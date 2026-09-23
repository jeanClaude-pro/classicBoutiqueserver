require("dotenv").config();
const mongoose = require("mongoose");

async function removeReceiptVerificationFields() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required");
  }

  await mongoose.connect(process.env.MONGO_URI);
  const hasSalesCollection = await mongoose.connection.db
    .listCollections({ name: "sales" }, { nameOnly: true })
    .hasNext();
  if (!hasSalesCollection) {
    console.log("No sales collection exists; no receipt verification data needed cleanup.");
    return;
  }

  const sales = mongoose.connection.collection("sales");
  const result = await sales.updateMany(
    { receiptVerification: { $exists: true } },
    { $unset: { receiptVerification: "" } }
  );

  const indexes = await sales.indexes();
  const obsoleteIndexes = indexes.filter((index) =>
    Object.keys(index.key).some((field) => field.startsWith("receiptVerification."))
  );
  for (const index of obsoleteIndexes) {
    await sales.dropIndex(index.name);
  }

  console.log(
    `Removed receiptVerification from ${result.modifiedCount} sale(s) and dropped ${obsoleteIndexes.length} obsolete index(es).`
  );
}

removeReceiptVerificationFields()
  .catch((error) => {
    console.error("Receipt verification cleanup failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
