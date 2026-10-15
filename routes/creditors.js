const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const Creditor = require("../models/Creditor");
const Loan = require("../models/Loan");
const Expense = require("../models/Expense");
const { normalizeAmountSnapshot } = require("../utils/salePricing");
const { getFallbackExchangeRate } = require("../utils/currentExchangeRate");

const router = express.Router();
const { validateObjectIdParam } = require("../middleware/security");
const { requireModuleAccess } = require("../middleware/moduleAccess");
const { recordAudit } = require("../services/auditLog");
const creditorSnapshot = (c) => c && ({ name: c.name, type: c.type, phone: c.phone, address: c.address, isActive: c.isActive, totalBorrowed: c.totalBorrowed, totalRepaid: c.totalRepaid, remainingBalance: c.remainingBalance });
router.param("id", validateObjectIdParam("creditor ID"));
const adminOnly= (req, res, next) => req.user?.role === "superadmin" ? next() : res.status(403).json({ error: "Superadministrator access required" });
const clean = (value, maxLength = 200) => (value !== null && typeof value === "object") ? "" : String(value || "").trim().slice(0, maxLength);

// The expense form (Sorties) picks the creditor of a repayment.
router.get("/selector", auth, requireModuleAccess("/sortie", "/sortiehistory", "/remboursements"), async (_req, res) => {
  const rows = await Creditor.find({ isActive: true }).select("name type phone").sort({ name: 1 }).lean();
  res.json(rows);
});

router.use(auth, adminOnly);

router.get("/", async (_req, res) => {
  const creditors = await Creditor.find().sort({ isActive: -1, name: 1 }).lean();
  res.json(creditors);
});

router.post("/", async (req, res) => {
  const name = clean(req.body.name);
  if (!name || !["person", "bank", "company"].includes(req.body.type)) return res.status(400).json({ error: "Valid name and type are required" });
  const creditor = await Creditor.create({ name, type: req.body.type, phone: clean(req.body.phone), address: clean(req.body.address), createdBy: req.user._id || req.user.id });
  await recordAudit({ req, action: "CREDITOR_CREATED", targetType: "Creditor", targetId: creditor._id, after: creditorSnapshot(creditor) });
  res.status(201).json(creditor);
});

router.put("/:id", async (req, res) => {
  const name = clean(req.body.name);
  if (!name || !["person", "bank", "company"].includes(req.body.type)) return res.status(400).json({ error: "Valid name and type are required" });
  const before = await Creditor.findById(req.params.id).lean();
  const creditor = await Creditor.findByIdAndUpdate(req.params.id, { name, type: req.body.type, phone: clean(req.body.phone), address: clean(req.body.address), updatedBy: req.user._id || req.user.id }, { new: true, runValidators: true });
  if (!creditor) return res.status(404).json({ error: "Creditor not found" });
  await recordAudit({ req, action: "CREDITOR_UPDATED", targetType: "Creditor", targetId: creditor._id, before: creditorSnapshot(before), after: creditorSnapshot(creditor) });
  res.json(creditor);
});

router.patch("/:id/archive", async (req, res) => {
  const creditor = await Creditor.findByIdAndUpdate(req.params.id, { isActive: false, updatedBy: req.user._id || req.user.id }, { new: true });
  if (!creditor) return res.status(404).json({ error: "Creditor not found" });
  await recordAudit({ req, action: "CREDITOR_ARCHIVED", targetType: "Creditor", targetId: creditor._id, after: creditorSnapshot(creditor) });
  res.json(creditor);
});

// A retried request with the same key returns the loan already recorded,
// so a dropped connection can never add the same debt twice.
function replayLoan(res, req, existing) {
  const sameRequest = String(existing.creditorId) === String(req.params.id) &&
    Math.round(Number(existing.enteredAmount) * 100) === Math.round(Number(req.body?.enteredAmount ?? req.body?.amount) * 100) &&
    existing.enteredCurrency === (req.body?.enteredCurrency || "USD");
  if (!sameRequest) return res.status(409).json({ error: "IDEMPOTENCY_CONFLICT", message: "Cette clé de requête a déjà été utilisée avec des données différentes." });
  return res.status(200).json(existing);
}

router.post("/:id/loans", async (req, res) => {
  const requestKey = typeof req.body?.requestKey === "string" ? req.body.requestKey.trim().slice(0, 100) || undefined : undefined;
  if (requestKey) {
    const existing = await Loan.findOne({ requestKey }).lean();
    if (existing) return replayLoan(res, req, existing);
  }
  let snapshot;
  try { snapshot = normalizeAmountSnapshot(req.body, await getFallbackExchangeRate()); } catch (error) { return res.status(400).json({ error: error.message }); }
  const borrowedAt = req.body.borrowedAt ? new Date(req.body.borrowedAt) : new Date();
  if (Number.isNaN(borrowedAt.getTime())) return res.status(400).json({ error: "Invalid borrowedAt date" });
  const session = await mongoose.startSession();
  try {
    let loan;
    await session.withTransaction(async () => {
      const creditor = await Creditor.findOneAndUpdate({ _id: req.params.id, isActive: true }, { $inc: { totalBorrowed: snapshot.amountUSD, remainingBalance: snapshot.amountUSD }, $set: { updatedBy: req.user._id || req.user.id } }, { new: true, session });
      if (!creditor) throw Object.assign(new Error("Active creditor not found"), { status: 404 });
      [loan] = await Loan.create([{ creditorId: creditor._id, ...snapshot, borrowedAt, reference: clean(req.body.reference), note: clean(req.body.note), requestKey, createdBy: req.user._id || req.user.id }], { session });
      await recordAudit({
        req, action: "LOAN_RECORDED", targetType: "Creditor", targetId: creditor._id,
        after: { loanId: String(loan._id), amountUSD: loan.amountUSD, amountFC: loan.amountFC, enteredAmount: loan.enteredAmount, enteredCurrency: loan.enteredCurrency, exchangeRate: loan.exchangeRate, borrowedAt: loan.borrowedAt, reference: loan.reference, remainingBalance: creditor.remainingBalance },
        session,
      });
    });
    res.status(201).json(loan);
  } catch (error) {
    if (error?.code === 11000 && requestKey) {
      const existing = await Loan.findOne({ requestKey }).lean();
      if (existing) return replayLoan(res, req, existing);
    }
    res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to record loan" });
  }
  finally { await session.endSession(); }
});

router.get("/:id/history", async (req, res) => {
  const creditor = await Creditor.findById(req.params.id).lean();
  if (!creditor) return res.status(404).json({ error: "Creditor not found" });
  const [loans, repayments] = await Promise.all([
    Loan.find({ creditorId: creditor._id }).populate("createdBy", "username role").sort({ borrowedAt: -1 }).lean(),
    Expense.find({ creditorId: creditor._id, expenseType: { $in: ["REPAYMENT", "repayment"] } }).select("expenseId amountUSD enteredAmount enteredCurrency exchangeRate status repaymentAppliedAt createdAt recordedBy notes").sort({ createdAt: -1 }).lean()
  ]);
  const sums = await Promise.all([
    Loan.aggregate([{ $match: { creditorId: creditor._id } }, { $group: { _id: null, total: { $sum: "$amountUSD" } } }]),
    Expense.aggregate([{ $match: { creditorId: creditor._id, expenseType: { $in: ["REPAYMENT", "repayment"] }, status: "validated", repaymentAppliedAt: { $ne: null } } }, { $group: { _id: null, total: { $sum: "$amountUSD" } } }])
  ]);
  res.json({ creditor, loans, repayments, reconciliation: { borrowed: sums[0][0]?.total || 0, repaid: sums[1][0]?.total || 0, calculatedOutstanding: (sums[0][0]?.total || 0) - (sums[1][0]?.total || 0), storedOutstanding: creditor.remainingBalance } });
});

router.use((error, _req, res, _next) => {
  if (error instanceof mongoose.Error.CastError) return res.status(400).json({ error: "Invalid identifier" });
  console.error("Creditor route error:", error);
  res.status(500).json({ error: "Creditor operation failed" });
});

module.exports = router;
