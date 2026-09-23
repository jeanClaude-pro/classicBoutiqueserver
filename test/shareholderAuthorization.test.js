const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  MODULES,
  authorizedCategory,
  blockShareholderMutations,
  requireAssignedCategory,
  requireShareholderModule,
} = require("../middleware/authorization");
const { categoryRestrictedSaleStages } = require("../utils/categoryScope");
const { migrateAdminDocuments } = require("../scripts/migrateAdminsToSuperadmin");
const { calculateProfitSnapshot } = require("../utils/profitCalculations");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const response = () => ({
  statusCode: 200,
  payload: null,
  status(code) { this.statusCode = code; return this; },
  json(value) { this.payload = value; return this; },
});

function migrationModel(documents) {
  return {
    async updateMany(filter, update) {
      const matches = documents.filter((document) => document.role === filter.role);
      for (const document of matches) {
        Object.assign(document, update.$set);
        for (const key of Object.keys(update.$unset || {})) delete document[key];
      }
      return { matchedCount: matches.length, modifiedCount: matches.length };
    },
  };
}

test("1. existing admins migrate to superadmin", async () => {
  const documents = [{ role: "admin", assignedCategory: "CLOTHES" }, { role: "staff" }];
  const result = await migrateAdminDocuments(migrationModel(documents));
  assert.deepEqual(result, { matched: 1, migrated: 1 });
  assert.deepEqual(documents, [{ role: "superadmin" }, { role: "staff" }]);
});

test("2. admin migration is idempotent", async () => {
  const documents = [{ role: "admin" }];
  await migrateAdminDocuments(migrationModel(documents));
  assert.deepEqual(await migrateAdminDocuments(migrationModel(documents)), { matched: 0, migrated: 0 });
});

test("3. future admins are not automatically promoted", async () => {
  const documents = [{ role: "admin" }];
  assert.equal(documents[0].role, "admin");
  assert.doesNotMatch(read("models/User.js"), /pre\([^)]*save[\s\S]*superadmin/);
});

test("4. superadmin has unrestricted category visibility", () => {
  assert.equal(authorizedCategory({ role: "superadmin" }, undefined), null);
  assert.equal(authorizedCategory({ role: "superadmin" }, "clothes"), "CLOTHES");
  assert.equal(authorizedCategory({ role: "superadmin" }, "shoes"), "SHOES");
});

test("5. clothes admin is restricted to clothes", () => {
  assert.equal(authorizedCategory({ role: "admin", assignedCategory: "CLOTHES" }, undefined), "CLOTHES");
});

test("6. shoes admin is restricted to shoes", () => {
  assert.equal(authorizedCategory({ role: "admin", assignedCategory: "SHOES" }, undefined), "SHOES");
});

test("7. clothes admin cannot request shoes", () => {
  assert.equal(authorizedCategory({ role: "admin", assignedCategory: "CLOTHES" }, "SHOES"), "CLOTHES");
});

test("8. shoes admin cannot request clothes", () => {
  assert.equal(authorizedCategory({ role: "admin", assignedCategory: "SHOES" }, "CLOTHES"), "SHOES");
});

test("9. shareholder mutations are denied for every business mutation verb", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = response();
    blockShareholderMutations({ method, user: { role: "admin" } }, res, () => assert.fail(method));
    assert.equal(res.statusCode, 403);
  }
});

test("10. admin cannot change their category", () => {
  const source = read("routes/users.js");
  assert.match(source, /router\.put\("\/:userId\/role"[\s\S]*req\.user\.role !== "superadmin"/);
});

test("11. admin cannot change their permissions", () => {
  const source = read("routes/users.js");
  assert.match(source, /router\.put\("\/:userId\/permissions"[\s\S]*req\.user\.role !== "superadmin"/);
});

test("12. admin cannot promote themselves to superadmin", () => {
  const source = read("routes/users.js");
  assert.match(source, /router\.put\("\/:userId\/role"[\s\S]*Superadmin role required/);
});

test("13. admin without category receives no protected financial access", () => {
  const res = response();
  requireAssignedCategory({ user: { role: "admin" } }, res, () => assert.fail());
  assert.equal(res.statusCode, 403);
});

test("14. disabled module cannot be accessed directly", () => {
  const res = response();
  requireShareholderModule(MODULES.REPORTS)(
    { user: { role: "admin", permissions: [MODULES.SALES_HISTORY] } },
    res,
    () => assert.fail()
  );
  assert.equal(res.statusCode, 403);
});

test("15. mixed-sale pipeline removes unauthorized items", () => {
  const stages = categoryRestrictedSaleStages("CLOTHES");
  assert.deepEqual(stages.slice(0, 3), [
    { $match: { "items.mainCategory": "CLOTHES" } },
    { $unwind: "$items" },
    { $match: { "items.mainCategory": "CLOTHES" } },
  ]);
  assert.equal(stages[4].$group.authorizedItems.$push, "$items");
});

test("16. mixed-sale pipeline recalculates restricted sale totals", () => {
  const set = categoryRestrictedSaleStages("SHOES")[5].$set;
  for (const field of ["sale.subtotal", "sale.total", "sale.totalRevenue", "sale.costOfGoodsSold", "sale.grossProfit"]) {
    assert.ok(set[field], `${field} must be recalculated`);
  }
  assert.deepEqual(set["sale.total"], { $sum: "$authorizedItems.revenue" });
});

test("17. clothes entitlement is 100% of clothes gross profit", () => {
  const result = calculateProfitSnapshot({ unitSellingPrice: 40, unitAcquisitionCost: 25, quantity: 2, mainCategory: "CLOTHES" });
  assert.equal(result.clothesShareholderProfit, result.grossProfit);
});

test("18. each shoes entitlement is 50% of shoes gross profit", () => {
  const result = calculateProfitSnapshot({ unitSellingPrice: 40, unitAcquisitionCost: 25, quantity: 2, mainCategory: "SHOES" });
  assert.equal(result.shoeShareholder1Profit, result.grossProfit / 2);
  assert.equal(result.shoeShareholder2Profit, result.grossProfit / 2);
});

test("19. historical acquisition-cost snapshots remain explicit and unchanged", () => {
  const result = calculateProfitSnapshot({ unitSellingPrice: 40, unitAcquisitionCost: 25, quantity: 2, mainCategory: "CLOTHES" });
  assert.equal(result.unitAcquisitionCost, 25);
  assert.equal(result.costOfGoodsSold, 50);
});

test("20. historical FC pricing snapshots remain explicit and unchanged", () => {
  const result = calculateProfitSnapshot({
    unitSellingPrice: 10,
    unitAcquisitionCost: 6,
    unitSellingPriceFC: 30000,
    unitAcquisitionCostFC: 18000,
    quantity: 2,
    mainCategory: "SHOES",
  });
  assert.equal(result.revenueFC, 60000);
  assert.equal(result.costOfGoodsSoldFC, 36000);
  assert.equal(result.grossProfitFC, 24000);
});
