// Server-side twin of canAccessNavigationItem (client/src/config/navigation.ts).
// The interface hides modules a user may not open; this enforces the same
// rule on the API so a hidden button is never the only protection.
//
// Rule (identical to the client):
// - superadmin: every module it is listed for (all of them);
// - shareholder admin: handled by requireShareholderModule (authorization.js);
// - any other role: a non-empty `permissions` list is authoritative,
//   otherwise the role's default modules below apply.
// Keep this table in sync with navigationSections in the client.

const MODULE_ROLES = Object.freeze({
  "/": ["superadmin", "manager", "cashier_supervisor", "inventory_manager"],
  "/sales": ["superadmin", "admin", "manager", "cashier_supervisor", "inventory_manager"],
  "/products": ["superadmin", "admin", "manager", "inventory_manager"],
  "/entry": ["superadmin", "cashier_supervisor", "inventory_manager", "manager"],
  "/sortie": ["superadmin", "cashier_supervisor", "inventory_manager", "manager"],
  "/entryhistory": ["superadmin", "cashier_supervisor", "inventory_manager", "manager"],
  "/sortiehistory": ["superadmin", "cashier_supervisor", "inventory_manager", "manager"],
  "/rate": ["superadmin"],
  "/remboursements": ["superadmin"],
  "/reports": ["superadmin", "admin"],
  "/customers": ["superadmin", "manager", "cashier_supervisor"],
  "/admin": ["superadmin"],
});

/** Module paths a superadmin may grant in the permission editor. */
const GRANTABLE_MODULES = new Set(Object.keys(MODULE_ROLES).filter((path) => path !== "/admin"));
const FIXED_ROLE_MODULES = new Set(["/admin"]);

function hasModuleAccess(user, modulePath) {
  const roles = MODULE_ROLES[modulePath];
  if (!roles || !user?.role) return false;
  if (user.role === "superadmin") return roles.includes("superadmin");
  if (FIXED_ROLE_MODULES.has(modulePath)) return roles.includes(user.role);
  if (user.role === "admin") {
    return roles.includes("admin") && Array.isArray(user.permissions) && user.permissions.includes(modulePath);
  }
  if (Array.isArray(user.permissions) && user.permissions.length > 0) return user.permissions.includes(modulePath);
  return roles.includes(user.role);
}

/** Allows the request when the user may open at least one of the modules. */
function requireModuleAccess(...modulePaths) {
  return (req, res, next) => {
    if (modulePaths.some((path) => hasModuleAccess(req.user, path))) return next();
    return res.status(403).json({ error: "MODULE_FORBIDDEN", message: "Module non autorisé pour ce compte" });
  };
}

module.exports = { GRANTABLE_MODULES, MODULE_ROLES, hasModuleAccess, requireModuleAccess };
