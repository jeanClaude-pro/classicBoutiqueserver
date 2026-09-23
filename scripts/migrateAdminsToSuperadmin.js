require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");

const ADMIN_MIGRATION_FILTER = Object.freeze({ role: "admin" });
const ADMIN_MIGRATION_UPDATE = Object.freeze({
  $set: { role: "superadmin" },
  $unset: { assignedCategory: "" },
});

async function migrateAdminDocuments(UserModel = User) {
  const result = await UserModel.updateMany(ADMIN_MIGRATION_FILTER, ADMIN_MIGRATION_UPDATE);
  return { matched: result.matchedCount, migrated: result.modifiedCount };
}

async function migrateAdminsToSuperadmin() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI);
  try {
    return await migrateAdminDocuments();
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  migrateAdminsToSuperadmin()
    .then((result) => console.log(`Admin migration complete: ${result.migrated}/${result.matched} updated`))
    .catch((error) => { console.error(`Admin migration failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = {
  ADMIN_MIGRATION_FILTER,
  ADMIN_MIGRATION_UPDATE,
  migrateAdminDocuments,
  migrateAdminsToSuperadmin,
};
