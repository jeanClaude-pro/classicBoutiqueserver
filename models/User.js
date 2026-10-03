const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      enum: ["superadmin", "admin", "manager", "inventory_manager", "cashier_supervisor", "staff"],
      default: "staff",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    permissions: {
      type: [String],
      default: [],
    },
    actionPermissions: {
      type: [String],
      default: [],
    },
    // Bumped on role change or deactivation: every token signed with an older
    // value is refused (see middleware/auth.js).
    tokenVersion: {
      type: Number,
      default: 0,
      select: false,
    },
    assignedCategory: {
      type: String,
      enum: ["CLOTHES", "SHOES"],
      default: undefined,
      required: function requiredForShareholderAdmin() { return this.role === "admin"; },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
