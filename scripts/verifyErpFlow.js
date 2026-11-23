require("dotenv").config();
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const User = require("../models/User");
const Product = require("../models/Product");
const Sale = require("../models/Sale");

const API_URL = process.env.E2E_API_URL || "http://localhost:5000/api";
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const email = `codex-e2e-${runId}@example.com`;
const password = `E2E-${runId}-Strong!`;
let userId;
const productIds = [];
let saleId;

async function request(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function verifyErpFlow() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  // This script creates and deletes users, products and sales: it must never
  // run against a shared or production database.
  const { hostname } = new URL(process.env.MONGO_URI.replace(/^mongodb(\+srv)?:/, "http:"));
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) {
    throw new Error("verifyErpFlow only runs against a local MongoDB (MONGO_URI host must be localhost)");
  }
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.create({
    username: `codex-e2e-${runId}`,
    email,
    password: await bcrypt.hash(password, 10),
    role: "admin",
    isActive: true,
  });
  userId = user._id;

  const login = await request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!login.token || login.user?.role !== "superadmin") throw new Error("Login did not return a superadmin JWT session");
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` };

  const productBodies = [
    { name: `E2E Clothes ${runId}`, mainCategory: "CLOTHES", subcategory: "Test clothes", purchasedQuantity: 10, unitCost: 10000, price: 20000, stock: 10 },
    { name: `E2E Shoes ${runId}`, mainCategory: "SHOES", subcategory: "Test shoes", purchasedQuantity: 8, unitCost: 20000, price: 40000, stock: 8 },
  ];
  for (const productBody of productBodies) {
    const product = await request("/products", { method: "POST", headers, body: JSON.stringify(productBody) });
    productIds.push(product._id);
  }

  const products = await request("/products", { headers });
  const createdProducts = products.filter((product) => productIds.includes(product._id));
  if (createdProducts.length !== 2) throw new Error("Created products were not returned by the products API");
  if (createdProducts.some((product) => product.totalAcquisitionCost !== product.unitCost * product.purchasedQuantity)) {
    throw new Error("Product total acquisition value was not calculated correctly");
  }

  const sale = await request("/sales", {
    method: "POST",
    headers,
    body: JSON.stringify({
      isWalkIn: true,
      customer: { name: "Client de passage", phone: "", email: "" },
      paymentMethod: "cash",
      salesPerson: login.user.username,
      type: "sale",
      // Every amount is FC (the only currency since the FC-only cutover).
      // 18,000 FC is a discount on the 20,000 FC clothes line, which needs
      // 5 pieces in the cart: 5 clothes + 1 pair of shoes.
      items: [
        { productId: productIds[0], name: productBodies[0].name, quantity: 5, price: 18000, enteredPrice: 18000, enteredCurrency: "FC" },
        { productId: productIds[1], name: productBodies[1].name, quantity: 1, price: 40000, enteredPrice: 40000, enteredCurrency: "FC" },
      ],
    }),
  });
  saleId = sale._id;
  const expected = { currency: "FC", totalRevenue: 130000, costOfGoodsSold: 70000, grossProfit: 60000, shopProfit: 50000, partnerProfit: 10000 };
  for (const [field, value] of Object.entries(expected)) {
    if (sale[field] !== value) throw new Error(`Unexpected ${field}: expected ${value}, received ${sale[field]}`);
  }

  const afterSale = await Promise.all(productIds.map((id) => request(`/products/${id}`, { headers })));
  if (afterSale[0].stock !== 5 || afterSale[1].stock !== 7) throw new Error("Sale did not decrease stock correctly");

  const sales = await request("/sales?type=sale&limit=50", { headers });
  if (!sales.data?.some((entry) => entry._id === saleId)) throw new Error("Created sale was not returned by the sales API");

  await request(`/sales/${saleId}`, { method: "DELETE", headers });
  saleId = null;
  const afterDelete = await Promise.all(productIds.map((id) => request(`/products/${id}`, { headers })));
  if (afterDelete[0].stock !== 10 || afterDelete[1].stock !== 8) throw new Error("Deleting the test sale did not restore stock");

  for (const id of [...productIds]) {
    await request(`/products/${id}`, { method: "DELETE", headers });
    productIds.splice(productIds.indexOf(id), 1);
  }

  console.log("E2E ERP flow passed: login/JWT, CLOTHES+SHOES creation, FC sale, stock, profit, list and cleanup.");
}

verifyErpFlow()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (saleId) await Sale.deleteOne({ _id: saleId }).catch(() => {});
    if (productIds.length) await Product.deleteMany({ _id: { $in: productIds } }).catch(() => {});
    if (userId) await User.deleteOne({ _id: userId }).catch(() => {});
    await mongoose.disconnect();
  });
