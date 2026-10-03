const express = require("express");
const router = express.Router();
const ExchangeRate = require("../models/ExchangeRate");
const authMiddleware = require("../middleware/auth");
const { validateObjectIdParam } = require("../middleware/security");
const { recordAudit } = require("../services/auditLog");
const { boundedString } = require("../utils/validation");

router.param("id", validateObjectIdParam("exchange rate ID"));

// A usable rate is a finite positive number (FC per USD).
const parseRate = (value) => {
  const rate = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(rate) && rate > 0 && rate < 1e7 ? rate : null;
};

// GET current active exchange rate
router.get("/current", authMiddleware, async (req, res) => {
  try {
    const currentRate = await ExchangeRate.getCurrentRate();
    
    if (!currentRate) {
      return res.status(404).json({ 
        error: "No active exchange rate found" 
      });
    }

    res.json({
      rate: currentRate.rate,
      effectiveFrom: currentRate.effectiveFrom,
      lastUpdated: currentRate.updatedAt,
      notes: currentRate.notes
    });
  } catch (error) {
    console.error("Error fetching current exchange rate:", error);
    res.status(500).json({ error: "Failed to fetch exchange rate" });
  }
});

// GET exchange rate history (Admin only)
router.get("/history", authMiddleware, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "superadmin" && req.user.role !== "manager") {
      return res.status(403).json({ 
        error: "Only admins and managers can view rate history" 
      });
    }

    const requested = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 100) : 50;
    const history = await ExchangeRate.getRateHistory(limit);

    res.json({
      history,
      total: history.length
    });
  } catch (error) {
    console.error("Error fetching exchange rate history:", error);
    res.status(500).json({ error: "Failed to fetch rate history" });
  }
});

// CREATE new exchange rate (Admin only)
router.post("/", authMiddleware, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "superadmin" && req.user.role !== "manager") {
      return res.status(403).json({ 
        error: "Only admins and managers can set exchange rates" 
      });
    }

    const { effectiveFrom } = req.body;
    const rate = parseRate(req.body.rate);
    const notes = boundedString(req.body.notes, 500);

    // Validate required fields
    if (!rate) {
      return res.status(400).json({
        error: "Valid exchange rate is required"
      });
    }
    const effectiveDate = effectiveFrom ? new Date(effectiveFrom) : new Date();
    if (Number.isNaN(effectiveDate.getTime())) {
      return res.status(400).json({ error: "Invalid effectiveFrom date" });
    }

    // Deactivate all previous rates
    await ExchangeRate.updateMany(
      { isActive: true },
      { isActive: false }
    );

    // Create new active rate
    const newRate = new ExchangeRate({
      rate,
      effectiveFrom: effectiveDate,
      createdBy: req.user.userId,
      notes
    });

    const savedRate = await newRate.save();
    await recordAudit({ req, action: "EXCHANGE_RATE_CREATED", targetType: "ExchangeRate", targetId: savedRate._id, after: { rate, effectiveFrom: effectiveDate } });

    res.status(201).json({
      message: "Exchange rate updated successfully",
      rate: savedRate
    });
  } catch (error) {
    console.error("Error creating exchange rate:", error);
    
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    
    res.status(500).json({ error: "Failed to update exchange rate" });
  }
});

// UPDATE exchange rate (Admin only)
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "superadmin" && req.user.role !== "manager") {
      return res.status(403).json({ 
        error: "Only admins and managers can update exchange rates" 
      });
    }

    const { id } = req.params;
    const { notes } = req.body;
    const rateProvided = req.body.rate !== undefined && req.body.rate !== null && req.body.rate !== "";
    const rate = rateProvided ? parseRate(req.body.rate) : null;

    const existingRate = await ExchangeRate.findById(id);
    if (!existingRate) {
      return res.status(404).json({ error: "Exchange rate not found" });
    }

    // Validate rate if provided
    if (rateProvided && !rate) {
      return res.status(400).json({
        error: "Valid exchange rate is required"
      });
    }

    const previousRate = existingRate.rate;
    // Update rate
    if (rate) existingRate.rate = rate;
    if (notes !== undefined) existingRate.notes = boundedString(notes, 500);

    const updatedRate = await existingRate.save();
    await recordAudit({ req, action: "EXCHANGE_RATE_UPDATED", targetType: "ExchangeRate", targetId: updatedRate._id, before: { rate: previousRate }, after: { rate: updatedRate.rate } });

    res.json({
      message: "Exchange rate updated successfully",
      rate: updatedRate
    });
  } catch (error) {
    console.error("Error updating exchange rate:", error);
    
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ error: errors.join(", ") });
    }
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid exchange rate ID" });
    }
    
    res.status(500).json({ error: "Failed to update exchange rate" });
  }
});

// DEACTIVATE exchange rate (Admin only)
router.patch("/:id/deactivate", authMiddleware, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== "superadmin" && req.user.role !== "manager") {
      return res.status(403).json({ 
        error: "Only admins and managers can deactivate exchange rates" 
      });
    }

    const { id } = req.params;

    const rate = await ExchangeRate.findById(id);
    if (!rate) {
      return res.status(404).json({ error: "Exchange rate not found" });
    }

    if (!rate.isActive) {
      return res.status(400).json({ error: "Exchange rate is already inactive" });
    }

    await rate.deactivate();
    await recordAudit({ req, action: "EXCHANGE_RATE_DEACTIVATED", targetType: "ExchangeRate", targetId: rate._id, details: { rate: rate.rate } });

    res.json({
      message: "Exchange rate deactivated successfully",
      rate
    });
  } catch (error) {
    console.error("Error deactivating exchange rate:", error);
    
    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid exchange rate ID" });
    }
    
    res.status(500).json({ error: "Failed to deactivate exchange rate" });
  }
});

module.exports = router;
