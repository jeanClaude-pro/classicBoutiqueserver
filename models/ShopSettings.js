const mongoose = require("mongoose");

const shopSettingsSchema = new mongoose.Schema(
  {
    shopName: { type: String, default: "ETS DOUBLE M CLASSIC BOUTIQUE" },
    shopAddress: {
      type: String,
      default: "780 AV. Du 30 Juin Coin Tabora, Q/MAKUTANO, C/Lubumbashi",
    },
    shopNumber: {
      type: String,
      default: "+243 836 017 031",
    },
    shopRegistration: { type: String, default: "LSH/RCCM/22-A-01266" },
    receiptFooter: {
      type: String,
      default: "Merci pour votre confiance ! À bientôt.",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ShopSettings", shopSettingsSchema);
