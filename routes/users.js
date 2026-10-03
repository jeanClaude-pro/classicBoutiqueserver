const express = require("express");
const router = express.Router();
const User = require("../models/User");
const authMiddleware = require("../middleware/auth");
const { validateObjectIdParam } = require("../middleware/security");
const { SHAREHOLDER_ALLOWED_MODULES } = require("../middleware/authorization");
const { GRANTABLE_MODULES } = require("../middleware/moduleAccess");
const { clearAccountLocks } = require("../middleware/loginThrottle");
const { recordAudit } = require("../services/auditLog");

// The owner account (SUPER_ADMIN_EMAIL) can only be changed by itself; other
// superadministrators cannot rename, demote, deactivate or delete it.
const SUPER_ADMIN_EMAIL = String(process.env.SUPER_ADMIN_EMAIL || "").trim().toLowerCase();
const VALID_ROLES = ["superadmin", "admin", "manager", "inventory_manager", "cashier_supervisor", "staff"];
const VALID_ACTIONS = new Set(["edit_receipts"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PUBLIC_FIELDS = "_id username email role assignedCategory isActive permissions actionPermissions createdAt";

router.use(authMiddleware);
router.param("userId", validateObjectIdParam("user ID"));

const isSuperAdmin = (user) => user?.role === "superadmin";
const isSelf = (req, userId) => String(userId) === req.user._id.toString();
const isProtectedOwner = (req, target) =>
  Boolean(SUPER_ADMIN_EMAIL) && target.email === SUPER_ADMIN_EMAIL && req.user.email !== SUPER_ADMIN_EMAIL;

function requireSuperAdmin(req, res) {
  if (isSuperAdmin(req.user)) return true;
  res.status(403).json({ message: "Access denied. Superadmin role required." });
  return false;
}

// True when removing this superadmin's role or active state would leave the
// system without any active superadministrator.
async function isLastActiveSuperadmin(target) {
  if (target.role !== "superadmin" || !target.isActive) return false;
  const others = await User.countDocuments({ _id: { $ne: target._id }, role: "superadmin", isActive: true });
  return others === 0;
}

const userSnapshot = (user) => user && {
  username: user.username, email: user.email, role: user.role, isActive: user.isActive,
  assignedCategory: user.assignedCategory, permissions: user.permissions, actionPermissions: user.actionPermissions,
};

// Get current user profile
router.get("/me", async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select(PUBLIC_FIELDS);
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Get all users — superadmin only.
router.get("/", async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const users = await User.find().select(PUBLIC_FIELDS);
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Update username — superadmin for any user, everyone else only themselves.
router.put("/:userId/username", async (req, res) => {
  try {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const targetId = req.params.userId;

    if (!isSuperAdmin(req.user) && !isSelf(req, targetId)) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (!username || username.length > 80) {
      return res.status(400).json({ message: "Le nom d'utilisateur ne peut pas être vide" });
    }

    const target = await User.findById(targetId);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (isProtectedOwner(req, target)) {
      return res.status(403).json({ message: "Action non autorisée sur ce compte" });
    }

    const before = target.username;
    target.username = username;
    await target.save();
    await recordAudit({ req, action: "USER_RENAMED", targetType: "User", targetId: target._id, before: { username: before }, after: { username } });

    res.json({ _id: target._id, username: target.username, email: target.email, role: target.role });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Update user role — superadmin only, never on its own account.
router.put("/:userId/role", async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    if (isSelf(req, req.params.userId)) {
      return res.status(400).json({ message: "Vous ne pouvez pas modifier le rôle de votre propre compte" });
    }

    const target = await User.findById(req.params.userId);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (isProtectedOwner(req, target)) {
      return res.status(403).json({ message: "Action non autorisée sur ce compte" });
    }

    const { role, assignedCategory } = req.body || {};
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }
    if (role === "admin" && !["CLOTHES", "SHOES"].includes(assignedCategory)) {
      return res.status(400).json({ message: "assignedCategory is required for shareholder admins" });
    }
    if (role !== "superadmin" && await isLastActiveSuperadmin(target)) {
      return res.status(409).json({ message: "Le dernier superadministrateur actif ne peut pas être rétrogradé" });
    }

    const roleUpdate = { role };
    if (role === "admin") {
      roleUpdate.assignedCategory = assignedCategory;
      roleUpdate.permissions = (target.permissions || []).filter((permission) =>
        SHAREHOLDER_ALLOWED_MODULES.has(permission)
      );
      roleUpdate.actionPermissions = [];
    }
    const update = role === "admin"
      ? { $set: roleUpdate, $inc: { tokenVersion: 1 } }
      : { $set: roleUpdate, $unset: { assignedCategory: "" }, $inc: { tokenVersion: 1 } };
    // Existing sessions of this account end: it must sign in again to obtain
    // a token for its new role.
    const updated = await User.findByIdAndUpdate(req.params.userId, update, { new: true })
      .select("_id username email role assignedCategory isActive permissions");
    await recordAudit({ req, action: "USER_ROLE_CHANGED", targetType: "User", targetId: target._id, before: userSnapshot(target), after: userSnapshot(updated) });

    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Toggle active status — superadmin only, never on its own account.
router.put("/:userId/status", async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    if (isSelf(req, req.params.userId)) {
      return res.status(400).json({ message: "Vous ne pouvez pas désactiver votre propre compte" });
    }

    const user = await User.findById(req.params.userId).select("+tokenVersion");
    if (!user) return res.status(404).json({ message: "User not found" });
    if (isProtectedOwner(req, user)) {
      return res.status(403).json({ message: "Action non autorisée sur ce compte" });
    }
    if (user.isActive && await isLastActiveSuperadmin(user)) {
      return res.status(409).json({ message: "Le dernier superadministrateur actif ne peut pas être désactivé" });
    }

    const wasActive = user.isActive;
    user.isActive = !user.isActive;
    // Deactivation also revokes every token already issued to the account.
    if (wasActive) user.tokenVersion = Number(user.tokenVersion || 0) + 1;
    await user.save();
    await recordAudit({ req, action: user.isActive ? "USER_ACTIVATED" : "USER_DEACTIVATED", targetType: "User", targetId: user._id, before: { isActive: wasActive }, after: { isActive: user.isActive } });

    res.json({
      message: `User ${user.isActive ? "activated" : "deactivated"} successfully`,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Delete user — superadmin only, never its own account or the last superadmin.
router.delete("/:userId", async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    if (isSelf(req, req.params.userId)) {
      return res.status(400).json({ message: "Vous ne pouvez pas supprimer votre propre compte" });
    }

    const target = await User.findById(req.params.userId);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (isProtectedOwner(req, target)) {
      return res.status(403).json({ message: "Action non autorisée sur ce compte" });
    }
    if (await isLastActiveSuperadmin(target)) {
      return res.status(409).json({ message: "Le dernier superadministrateur actif ne peut pas être supprimé" });
    }

    await User.findByIdAndDelete(req.params.userId);
    await recordAudit({ req, action: "USER_DELETED", targetType: "User", targetId: target._id, before: userSnapshot(target) });
    res.json({ message: "User deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Update page permissions — superadmin only; only known module paths.
router.put("/:userId/permissions", async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const { permissions: requested } = req.body || {};
    if (!Array.isArray(requested) || requested.length > 50 || requested.some((permission) => typeof permission !== "string")) {
      return res.status(400).json({ message: "Permissions must be an array of module paths" });
    }
    // Unknown paths (e.g. a removed module still stored on an old account)
    // are dropped rather than granted.
    const permissions = requested.filter((permission) => GRANTABLE_MODULES.has(permission));

    const target = await User.findById(req.params.userId);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (target.role === "admin" && permissions.some((permission) => !SHAREHOLDER_ALLOWED_MODULES.has(permission))) {
      return res.status(400).json({
        message: "Shareholder admins can only access sales history, reports, and products",
      });
    }
    if (isProtectedOwner(req, target)) {
      return res.status(403).json({ message: "Action non autorisée sur ce compte" });
    }

    const unique = [...new Set(permissions)];
    const updated = await User.findByIdAndUpdate(req.params.userId, { $set: { permissions: unique } }, { new: true })
      .select("_id username email role assignedCategory isActive permissions actionPermissions");
    await recordAudit({ req, action: "USER_PERMISSIONS_CHANGED", targetType: "User", targetId: target._id, before: { permissions: target.permissions }, after: { permissions: unique } });

    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Update action permissions — superadmin only; only known actions.
router.put("/:userId/actions", async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const { actionPermissions } = req.body || {};
    if (!Array.isArray(actionPermissions) ||
        actionPermissions.some((action) => typeof action !== "string" || !VALID_ACTIONS.has(action))) {
      return res.status(400).json({ message: "actionPermissions must be an array of known actions" });
    }

    const target = await User.findById(req.params.userId);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (target.role === "admin" && actionPermissions.length > 0) {
      return res.status(400).json({ message: "Shareholder admins cannot receive mutation permissions" });
    }
    if (isProtectedOwner(req, target)) {
      return res.status(403).json({ message: "Action non autorisée sur ce compte" });
    }

    const unique = [...new Set(actionPermissions)];
    const updated = await User.findByIdAndUpdate(req.params.userId, { $set: { actionPermissions: unique } }, { new: true })
      .select("_id username email role isActive permissions actionPermissions");
    await recordAudit({ req, action: "USER_ACTIONS_CHANGED", targetType: "User", targetId: target._id, before: { actionPermissions: target.actionPermissions }, after: { actionPermissions: unique } });

    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Update profile (username/email) — own account or superadmin.
router.put("/:userId/profile", async (req, res) => {
  try {
    const { username, email } = req.body || {};
    const targetId = req.params.userId;

    if (!isSuperAdmin(req.user) && !isSelf(req, targetId)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const target = await User.findById(targetId);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (isProtectedOwner(req, target)) {
      return res.status(403).json({ message: "Action non autorisée sur ce compte" });
    }

    const updateData = {};
    if (username !== undefined && username !== "") {
      const cleanName = typeof username === "string" ? username.trim() : "";
      if (!cleanName || cleanName.length > 80) return res.status(400).json({ message: "Invalid username" });
      updateData.username = cleanName;
    }
    if (email !== undefined && email !== "") {
      const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
      if (cleanEmail.length > 254 || !EMAIL_PATTERN.test(cleanEmail)) {
        return res.status(400).json({ message: "Invalid email" });
      }
      updateData.email = cleanEmail;
    }

    const updated = await User.findByIdAndUpdate(targetId, { $set: updateData }, { new: true })
      .select("_id username email role isActive");
    await recordAudit({ req, action: "USER_PROFILE_CHANGED", targetType: "User", targetId: target._id, before: { username: target.username, email: target.email }, after: updateData });

    res.json(updated);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Email already exists" });
    }
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Unlock login — superadmin clears the brute-force lock of an account.
router.delete("/:userId/login-lock", async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const target = await User.findById(req.params.userId).select("_id email");
    if (!target) return res.status(404).json({ message: "User not found" });
    const cleared = await clearAccountLocks(target.email);
    await recordAudit({ req, action: "USER_LOGIN_UNLOCKED", targetType: "User", targetId: target._id, details: { cleared } });
    res.json({ success: true, cleared });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
