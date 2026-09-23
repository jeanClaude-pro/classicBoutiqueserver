const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relativePath) =>
  fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");

test("sale and receipt routes contain no receipt QR control workflow", () => {
  const activeServerSource = [
    read("models/Sale.js"),
    read("routes/sales.js"),
    read("routes/print.js"),
    read("index.js"),
  ].join("\n");

  assert.doesNotMatch(
    activeServerSource,
    /receiptVerification|receiptToken|receipt-control|receipt\/approve|receipt\/verify|\.qrcode\(/i
  );
});

test("thermal receipt and stub still open, print, feed and cut independently", () => {
  const printRoutes = read("routes/print.js");
  assert.match(printRoutes, /router\.post\('\/receipt'/);
  assert.match(printRoutes, /router\.post\('\/stub'/);
  assert.ok((printRoutes.match(/device\.open/g) || []).length >= 2);
  assert.ok((printRoutes.match(/\.feed\(/g) || []).length >= 2);
  assert.ok((printRoutes.match(/\.cut\(\)/g) || []).length >= 2);
  assert.ok((printRoutes.match(/\.close\(/g) || []).length >= 2);
});
