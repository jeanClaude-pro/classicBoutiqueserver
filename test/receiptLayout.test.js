const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const express = require("express");
const {
  amountRow,
  formatReceiptFC,
  itemTableRows,
  receiptLabels,
  receiptLines,
  receiptTotalFC,
  wrapText,
} = require("../utils/receiptLayout");

// Stored sale items exactly as the API returns them (same fixtures as
// client/test/saleReceipt.test.ts, so both renderers agree on every amount).
const fcEntered = { name: "SAMBASO", quantity: 1, price: 10.7142857, enteredPrice: 30000, enteredCurrency: "FC", priceUSD: 10.7142857, priceFC: 30000, exchangeRate: 2800, total: 10.7142857 };
const usdEntered = { name: "CHEMISE", quantity: 2, price: 12.99, enteredPrice: 12.99, enteredCurrency: "USD", priceUSD: 12.99, priceFC: 36372, exchangeRate: 2800, total: 25.98 };
const labels = receiptLabels();

test("receipt amounts are whole francs with a fixed separator", () => {
  assert.equal(formatReceiptFC(30000), "30,000 FC");
  assert.equal(formatReceiptFC(1250000), "1,250,000 FC");
  assert.equal(formatReceiptFC(36371.6), "36,372 FC");
  assert.equal(formatReceiptFC(undefined), "—");
});

test("each line is priced in FC from the sale's own snapshot", () => {
  const lines = receiptLines([fcEntered, usdEntered], 2800);
  assert.deepEqual(lines, [
    { name: "SAMBASO", quantity: 1, unitFC: 30000, totalFC: 30000 },
    { name: "CHEMISE", quantity: 2, unitFC: 36372, totalFC: 72744 },
  ]);
  assert.equal(receiptTotalFC(lines), 102744);
});

test("an old sale keeps its historical francs whatever today's rate", () => {
  const legacy = { name: "CHAUSSURE", quantity: 3, price: 20, total: 60 };
  assert.equal(receiptLines([legacy], 2500)[0].unitFC, 50000);
  assert.equal(receiptLines([{ ...legacy, exchangeRate: 2400 }], 2800)[0].unitFC, 48000);
  assert.equal(receiptLines([{ ...legacy, priceFC: 55000 }], 2800)[0].unitFC, 55000);
  assert.equal(receiptTotalFC(receiptLines([legacy])), undefined);
});

test("the product table has ARTICLE | PU | QTE | TOTAL aligned within 42 columns", () => {
  const big = { name: "ENSEMBLE BAZIN BRODE GRANDE TAILLE", quantity: 12, priceFC: 1250000 };
  const rows = itemTableRows(receiptLines([fcEntered, usdEntered, big], 2800), labels, 42);
  assert.deepEqual(rows, [
    "------------------------------------------",
    "ARTICLE               PU QTE         TOTAL",
    "------------------------------------------",
    "SAMBASO        30,000 FC   1     30,000 FC",
    "CHEMISE        36,372 FC   2     72,744 FC",
    "ENSEMBLE    1,250,000 FC  12 15,000,000 FC",
    "BAZIN BRODE",
    "GRANDE",
    "TAILLE",
    "------------------------------------------",
  ]);
  for (const row of rows) assert.ok(row.length <= 42, row);
  assert.equal(amountRow(labels.total, 102744, 42), `TOTAL:${"102,744 FC".padStart(36)}`);
});

test("a too-narrow printer puts the name on its own line and keeps the numbers aligned", () => {
  const big = { name: "ENSEMBLE", quantity: 12, priceFC: 1250000 };
  const rows = itemTableRows(receiptLines([big], 2800), labels, 32);
  assert.deepEqual(rows.slice(1, 6), [
    "ARTICLE",
    "          PU QTE         TOTAL".padStart(32),
    "-".repeat(32),
    "ENSEMBLE",
    "1,250,000 FC  12 15,000,000 FC".padStart(32),
  ]);
  for (const row of rows) assert.ok(row.length <= 32, row);
});

test("long names wrap on spaces and hard-split words longer than the column", () => {
  assert.deepEqual(wrapText("ROBE LONGUE SOIREE", 10), ["ROBE", "LONGUE", "SOIREE"]);
  assert.deepEqual(wrapText("ABCDEFGHIJKLMNO", 6), ["ABCDEF", "GHIJKL", "MNO"]);
  assert.deepEqual(wrapText("", 6), [""]);
});

test("labels come from the client in the interface language, French otherwise", () => {
  assert.equal(labels.item, "ARTICLE");
  assert.equal(labels.unitPrice, "PU");
  const english = receiptLabels({ item: "ITEM", unitPrice: "UP", qty: "QTY", bogus: "x", total: 5 });
  assert.equal(english.item, "ITEM");
  assert.equal(english.unitPrice, "UP");
  assert.equal(english.qty, "QTY");
  assert.equal(english.total, "TOTAL");
  assert.equal(english.bogus, undefined);
});

// Runs the real /print routes against a fake USB printer and returns every
// printed line and printer command.
async function printThroughRoute(route, receiptData) {
  const commands = [];
  const printer = {
    device: { open: (callback) => callback(null) },
    close: (callback) => { commands.push(["close"]); callback(); },
  };
  for (const name of ["font", "align", "style", "size", "text", "feed", "cut"]) {
    printer[name] = (...args) => { commands.push([name, ...args]); return printer; };
  }
  class FakePrinter { constructor() { return printer; } }
  const fakes = {
    escpos: { Printer: FakePrinter },
    "escpos-usb": class {},
    "../middleware/auth": (req, res, next) => next(),
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  const routePath = path.join(__dirname, "..", "routes", "print.js");
  delete require.cache[routePath];
  let router;
  try { router = require(routePath); } finally { Module._load = originalLoad; delete require.cache[routePath]; }

  const app = express();
  app.use(express.json());
  app.use("/print", router);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/print/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receiptData, type: "sale" }),
    });
    assert.equal(response.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return { commands, text: commands.filter(([name]) => name === "text").map(([, value]) => String(value)) };
}

const receiptData = {
  shopName: "ETS DOUBLE M CLASSIC BOUTIQUE",
  shopAddress: "780 AV. Du 30 Juin",
  shopNumber: "+243 975 085 799",
  shopRegistration: "LSH/RCCM/22-A-01266",
  customerName: "Awa",
  customerPhone: "0990000000",
  items: [fcEntered, usdEntered],
  exchangeRate: 2800,
  paymentMethod: "cash",
  salesPerson: "caissier",
  date: "26/09/2026 10:00",
  receiptNumber: "V-0001",
  stubNumber: "V-0001",
};

test("the thermal receipt and stub print FC-only amounts with no $ at all", async () => {
  for (const route of ["receipt", "stub"]) {
    const { commands, text } = await printThroughRoute(route, receiptData);
    const printed = text.join("\n");
    assert.ok(!printed.includes("$"), `${route} printed a $ amount:\n${printed}`);
    assert.doesNotMatch(printed, /12\.99|25\.98|USD/);
    assert.ok(text.includes("SAMBASO            30,000 FC   1 30,000 FC"), printed);
    assert.ok(text.includes("CHEMISE            36,372 FC   2 72,744 FC"), printed);
    assert.ok(text.some((row) => /^ARTICLE +PU QTE +TOTAL$/.test(row)), printed);
    assert.match(printed, /TOTAL: +102,744 FC/);
    assert.match(printed, /PAIEMENT: CASH/);
    // The open → print → feed → cut → close sequence is unchanged.
    const names = commands.map(([name]) => name);
    assert.ok(names.indexOf("cut") > names.lastIndexOf("text"));
    assert.equal(names.at(-1), "close");
  }
  const receipt = (await printThroughRoute("receipt", receiptData)).text.join("\n");
  assert.match(receipt, /SOUS-TOTAL: +102,744 FC/);
  assert.match(receipt, /CLIENT: Awa/);
  assert.match(receipt, /TÉLÉPHONE: 0990000000/);
  assert.match(receipt, /AGENT: caissier/);
  const stub = (await printThroughRoute("stub", receiptData)).text.join("\n");
  assert.match(stub, /SOUCHE N°V-0001 DU JOUR/);
});

test("the thermal receipt uses the client's English labels and payment wording", async () => {
  const { text } = await printThroughRoute("receipt", {
    ...receiptData,
    paymentLabel: "CASH",
    labels: { item: "ITEM", unitPrice: "UP", qty: "QTY", total: "TOTAL", subtotal: "SUBTOTAL", payment: "PAYMENT", customer: "CUSTOMER", phone: "PHONE", agent: "AGENT" },
  });
  const printed = text.join("\n");
  assert.ok(text.some((row) => /^ITEM +UP QTY +TOTAL$/.test(row)), printed);
  for (const label of ["SUBTOTAL:", "PAYMENT: CASH", "CUSTOMER: Awa", "PHONE: 0990000000", "AGENT: caissier"]) {
    assert.ok(printed.includes(label), label);
  }
  assert.ok(text.includes("SAMBASO            30,000 FC   1 30,000 FC"), printed);
});
