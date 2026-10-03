const express = require("express");
const router = express.Router();
const ShopSettings = require("../models/ShopSettings");
const authMiddleware = require("../middleware/auth");
const { recordAudit } = require("../services/auditLog");

router.use(authMiddleware);

async function getOrCreateSettings() {
  let settings = await ShopSettings.findOne();
  if (!settings) {
    settings = await ShopSettings.create({});
  }
  return settings;
}

// GET receipt settings — all authenticated users (needed to populate receipts)
router.get("/receipt", async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    res.json(settings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// PUT receipt settings — admin only
router.put("/receipt", async (req, res) => {
  try {
    if (req.user.role !== "superadmin") {
      return res.status(403).json({ message: "Accès refusé. Réservé aux administrateurs." });
    }
    const fields = { shopName: 120, shopAddress: 300, shopNumber: 60, shopRegistration: 120, receiptFooter: 500 };
    const settings = await getOrCreateSettings();
    const before = {};
    for (const [field, maxLength] of Object.entries(fields)) {
      const value = req.body?.[field];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.length > maxLength) {
        return res.status(400).json({ message: `Invalid ${field}` });
      }
      before[field] = settings[field];
      settings[field] = value.trim();
    }

    await settings.save();
    await recordAudit({ req, action: "SETTINGS_UPDATED", targetType: "ShopSettings", targetId: settings._id, before, after: Object.fromEntries(Object.keys(before).map((field) => [field, settings[field]])) });
    res.json(settings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
