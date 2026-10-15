const express = require("express");
const AuditLog = require("../models/AuditLog");
const authMiddleware = require("../middleware/auth");
const { requireSuperadmin } = require("../middleware/authorization");
const { parsePagination, paginationMetadata } = require("../utils/queryHelpers");

// Read-only access to the audit trail. There is deliberately no route that
// creates, edits or deletes audit entries.
const router = express.Router();
router.use(authMiddleware, requireSuperadmin);

const ACTION_PATTERN = /^[A-Z_]{1,64}$/;

router.get("/", async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};
    if (typeof req.query.action === "string" && ACTION_PATTERN.test(req.query.action)) filter.action = req.query.action;
    if (typeof req.query.targetId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(req.query.targetId)) filter.targetId = req.query.targetId;
    if (typeof req.query.targetType === "string" && /^[A-Za-z]{1,40}$/.test(req.query.targetType)) filter.targetType = req.query.targetType;
    if (req.query.outcome === "success" || req.query.outcome === "failure") filter.outcome = req.query.outcome;
    if (typeof req.query.actor === "string" && /^[\w.@ -]{1,120}$/.test(req.query.actor)) filter.actorName = req.query.actor;
    // Optional period (YYYY-MM-DD, inclusive), so a day or a shift can be reviewed.
    const day = (value, endOfDay) => {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+02:00`);
      return Number.isNaN(date.getTime()) ? null : date;
    };
    const from = day(req.query.from, false);
    const to = day(req.query.to, true);
    if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    const [rows, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ]);
    res.set("Cache-Control", "no-store");
    res.json({ data: rows, pagination: paginationMetadata(page, limit, total) });
  } catch (error) {
    console.error("Error reading audit log:", error?.name || "Error");
    res.status(500).json({ error: "Failed to read audit log" });
  }
});

module.exports = router;
