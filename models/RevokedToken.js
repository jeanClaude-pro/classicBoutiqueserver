const mongoose = require("mongoose");

// JWT ids revoked by an explicit logout. A row only needs to live until the
// token would have expired anyway; MongoDB's TTL monitor removes it then.
const revokedTokenSchema = new mongoose.Schema({
  jti: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

revokedTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("RevokedToken", revokedTokenSchema);
