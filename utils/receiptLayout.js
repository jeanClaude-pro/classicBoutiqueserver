// Text layout of the thermal (ESC/POS) sale receipt and stub. Customer-facing
// money is printed in Congolese francs only: each line's FC value comes from
// the sale's own stored snapshot (entered FC price, FC price snapshot, or its
// USD price at the sale's historical rate), never from today's rate.
// Mirrors client/src/lib/saleReceipt.ts, which renders the browser receipt.

// Characters per line of an 80mm printer in font A. 42 fits every common
// 80mm model (48-column printers simply keep a margin); override with
// RECEIPT_LINE_WIDTH when the printer is known to be wider.
const DEFAULT_LINE_WIDTH = 42;
// Below this the ARTICLE column is too narrow to read: the name then gets its
// own full-width line(s) and PU / QTE / TOTAL are printed underneath.
const MIN_NAME_WIDTH = 8;

const DEFAULT_LABELS = {
  tagline: "_Vêtements & Chaussures_",
  date: "Date",
  receiptNo: "Reçu #",
  customer: "CLIENT",
  phone: "TÉLÉPHONE",
  email: "EMAIL",
  item: "ARTICLE",
  unitPrice: "PU",
  qty: "QTE",
  total: "TOTAL",
  subtotal: "SOUS-TOTAL",
  saleTotal: "TOTAL",
  payment: "PAIEMENT",
  agent: "AGENT",
  thanks: "Merci pour votre achat !",
  noExchange: "Non échangeable - Non remboursable",
  stubTitle: "SOUCHE",
  stubNumber: "SOUCHE N°{{number}} DU JOUR",
};

function lineWidth() {
  const configured = Number(process.env.RECEIPT_LINE_WIDTH);
  return Number.isInteger(configured) && configured >= 32 && configured <= 64 ? configured : DEFAULT_LINE_WIDTH;
}

/** Client-supplied labels (current UI language) over the French defaults. */
function receiptLabels(supplied) {
  const labels = { ...DEFAULT_LABELS };
  if (supplied && typeof supplied === "object") {
    for (const key of Object.keys(DEFAULT_LABELS)) {
      const value = supplied[key];
      if (typeof value === "string" && value.trim()) labels[key] = value.slice(0, 80);
    }
  }
  return labels;
}

const finite = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

// Same priority as getItemFcUnitPrice (client/src/utils/salePricing.ts).
function fcUnitPrice(item, saleRate) {
  const entered = finite(item.enteredPrice);
  if (item.enteredCurrency === "FC" && entered !== undefined) return entered;
  const priceFC = finite(item.priceFC);
  if (priceFC !== undefined) return priceFC;
  const rate = finite(item.exchangeRate) ?? finite(saleRate);
  const usd = finite(item.unitSellingPrice ?? item.priceUSD ?? item.price ?? item.unitPrice);
  return rate && rate > 0 && usd !== undefined ? Math.round(usd * rate) : undefined;
}

/** One ARTICLE / PU / QTE / TOTAL line per sale item, in FC. */
function receiptLines(items, saleRate) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const quantity = Number(item.quantity) || 0;
    const unitFC = fcUnitPrice(item, saleRate);
    return {
      name: String(item.name ?? ""),
      quantity,
      unitFC,
      totalFC: unitFC === undefined ? undefined : unitFC * quantity,
    };
  });
}

/** Sum of the line totals; unknown when a line has no FC value. */
function receiptTotalFC(lines) {
  if (!lines.length || lines.some((line) => line.totalFC === undefined)) return undefined;
  return lines.reduce((sum, line) => sum + line.totalFC, 0);
}

/** "30,000 FC" — whole francs, locale independent so every printer agrees. */
function formatReceiptFC(value) {
  const amount = finite(value);
  if (amount === undefined) return "—";
  return `${String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} FC`;
}

/** Splits text into chunks of at most `width`, on spaces where possible. */
function wrapText(text, width) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const rows = [];
  let current = "";
  for (let word of words) {
    while (word.length > width) {
      if (current) { rows.push(current); current = ""; }
      rows.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!word) continue;
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else { rows.push(current); current = word; }
  }
  if (current) rows.push(current);
  return rows.length ? rows : [""];
}

/**
 * The product table: rule, header, rule, one row per item (the ARTICLE
 * column wraps, the three numeric columns stay aligned), closing rule.
 */
function itemTableRows(lines, labels, width = lineWidth()) {
  const cells = lines.map((line) => ({
    name: line.name,
    unit: formatReceiptFC(line.unitFC),
    qty: String(line.quantity),
    total: formatReceiptFC(line.totalFC),
  }));
  const unitW = Math.max(labels.unitPrice.length, ...cells.map((cell) => cell.unit.length));
  const qtyW = Math.max(labels.qty.length, ...cells.map((cell) => cell.qty.length));
  const totalW = Math.max(labels.total.length, ...cells.map((cell) => cell.total.length));
  const numbers = (unit, qty, total) => `${unit.padStart(unitW)} ${qty.padStart(qtyW)} ${total.padStart(totalW)}`;
  const nameW = width - unitW - qtyW - totalW - 3;
  const rule = "-".repeat(width);
  const rows = [rule];

  if (nameW >= MIN_NAME_WIDTH) {
    rows.push(`${labels.item.slice(0, nameW).padEnd(nameW)} ${numbers(labels.unitPrice, labels.qty, labels.total)}`, rule);
    for (const cell of cells) {
      const [first, ...rest] = wrapText(cell.name, nameW);
      rows.push(`${first.padEnd(nameW)} ${numbers(cell.unit, cell.qty, cell.total)}`, ...rest);
    }
  } else {
    rows.push(labels.item, numbers(labels.unitPrice, labels.qty, labels.total).padStart(width), rule);
    for (const cell of cells) {
      rows.push(...wrapText(cell.name, width), numbers(cell.unit, cell.qty, cell.total).padStart(width));
    }
  }
  rows.push(rule);
  return rows;
}

/** "LABEL:" on the left, the amount right-aligned on the same line. */
function amountRow(label, amount, width = lineWidth()) {
  const left = `${label}:`;
  const right = formatReceiptFC(amount);
  const gap = Math.max(1, width - left.length - right.length);
  return `${left}${" ".repeat(gap)}${right}`;
}

module.exports = {
  DEFAULT_LABELS,
  DEFAULT_LINE_WIDTH,
  amountRow,
  fcUnitPrice,
  formatReceiptFC,
  itemTableRows,
  lineWidth,
  receiptLabels,
  receiptLines,
  receiptTotalFC,
  wrapText,
};
