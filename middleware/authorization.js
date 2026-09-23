const SHAREHOLDER_ROLE = "admin";
const SUPERADMIN_ROLE = "superadmin";
const VALID_CATEGORIES = new Set(["CLOTHES", "SHOES"]);

const MODULES = Object.freeze({
  SALES_HISTORY: "/sales",
  REPORTS: "/reports",
  PRODUCTS: "/products",
  CUSTOMERS: "/customers",
  ENTRIES: "/entryhistory",
  EXPENSES: "/sortiehistory",
  EXCHANGE_RATES: "/rate",
  DEBTS: "/remboursements",
});
const SHAREHOLDER_ALLOWED_MODULES = new Set([
  MODULES.SALES_HISTORY,
  MODULES.REPORTS,
  MODULES.PRODUCTS,
]);

function isSuperadmin(user) { return user?.role === SUPERADMIN_ROLE; }
function isShareholderAdmin(user) { return user?.role === SHAREHOLDER_ROLE; }

function requireSuperadmin(req, res, next) {
  if (!isSuperadmin(req.user)) return res.status(403).json({ message: "Accès réservé au superadministrateur" });
  next();
}

function requireShareholderModule(...allowedModules) {
  return (req, res, next) => {
    if (!isShareholderAdmin(req.user)) return next();
    const permissions = Array.isArray(req.user.permissions) ? req.user.permissions : [];
    if (!allowedModules.some((module) => permissions.includes(module))) {
      return res.status(403).json({ message: "Module non autorisé pour ce compte actionnaire" });
    }
    next();
  };
}

function requireAssignedCategory(req, res, next) {
  if (!isShareholderAdmin(req.user)) return next();
  if (!VALID_CATEGORIES.has(req.user.assignedCategory)) {
    return res.status(403).json({ message: "Aucune catégorie actionnaire n’est assignée à ce compte" });
  }
  next();
}

function blockShareholderMutations(req, res, next) {
  if (isShareholderAdmin(req.user) && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return res.status(403).json({ message: "Les comptes actionnaires sont en lecture seule" });
  }
  next();
}

function authorizedCategory(user, requestedCategory) {
  if (isShareholderAdmin(user)) return VALID_CATEGORIES.has(user.assignedCategory) ? user.assignedCategory : null;
  if (isSuperadmin(user) && VALID_CATEGORIES.has(String(requestedCategory || "").toUpperCase())) {
    return String(requestedCategory).toUpperCase();
  }
  return null;
}

module.exports = {
  MODULES,
  SHAREHOLDER_ALLOWED_MODULES,
  VALID_CATEGORIES,
  authorizedCategory,
  blockShareholderMutations,
  isShareholderAdmin,
  isSuperadmin,
  requireAssignedCategory,
  requireShareholderModule,
  requireSuperadmin,
};
