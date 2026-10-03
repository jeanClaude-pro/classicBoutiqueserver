const mongoose = require("mongoose");

// Persistent failed-login counters (survive restarts and multiple instances).
// kind "account": one IP + one email (hashed key, email kept for admin unlock).
// kind "ip": every failed attempt from one IP, whatever the email.
const loginThrottleSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  kind: { type: String, enum: ["account", "ip"], required: true },
  email: { type: String, default: undefined },
  count: { type: Number, default: 0 },
  windowStart: { type: Date, default: Date.now },
  blockedUntil: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

loginThrottleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
loginThrottleSchema.index({ email: 1 });

module.exports = mongoose.model("LoginThrottle", loginThrottleSchema);
