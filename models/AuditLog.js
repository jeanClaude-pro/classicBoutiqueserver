const mongoose = require("mongoose");

// Append-only audit trail of sensitive actions. No route updates or deletes
// these documents; the only API access is a read-only superadmin listing.
const auditLogSchema = new mongoose.Schema({
  action: { type: String, required: true, trim: true },
  outcome: { type: String, enum: ["success", "failure"], default: "success" },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: undefined },
  actorName: { type: String, default: undefined },
  actorRole: { type: String, default: undefined },
  targetType: { type: String, default: undefined },
  targetId: { type: String, default: undefined },
  before: { type: mongoose.Schema.Types.Mixed, default: undefined },
  after: { type: mongoose.Schema.Types.Mixed, default: undefined },
  details: { type: mongoose.Schema.Types.Mixed, default: undefined },
  ip: { type: String, default: undefined },
}, { timestamps: { createdAt: true, updatedAt: false } });

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

// Defence in depth: refuse document-level edits from application code.
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"]) {
  auditLogSchema.pre(op, function blockMutation(next) {
    next(new Error("Audit log entries are immutable"));
  });
}

module.exports = mongoose.model("AuditLog", auditLogSchema);
