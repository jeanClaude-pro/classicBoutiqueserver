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
