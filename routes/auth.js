// routes/auth.js
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const RevokedToken = require("../models/RevokedToken");
const bcrypt = require("bcryptjs");
const generateToken = require("../utils/generateToken");
const authMiddleware = require("../middleware/auth");
const { rateLimit } = require("express-rate-limit");
const { loginThrottleGuard, recordLoginFailure, recordLoginSuccess } = require("../middleware/loginThrottle");
const { recordAudit } = require("../services/auditLog");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVALID_CREDENTIALS = { message: "Invalid email or password" };

// Sign-up abuse limit. No rate-limit headers: they would reveal the window.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: false,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again later." },
});

// Constant-cost comparison target for unknown emails, so response time does
// not reveal whether an account exists.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 10);

function safeUser(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    role: user.role,
    assignedCategory: user.assignedCategory,
    isActive: user.isActive,
    permissions: user.permissions || [],
    actionPermissions: user.actionPermissions || [],
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

// Public sign-up creates a least-privileged staff account that stays inactive
// until a superadministrator activates it. No session token is issued.
router.post("/register", registerLimiter, async (req, res) => {
  try {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!username || username.length > 80) {
      return res.status(400).json({ message: "Le nom d'utilisateur est requis (80 caractères maximum)" });
    }
    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      return res.status(400).json({ message: "Adresse email invalide" });
    }
    if (password.length < 10 || password.length > 128) {
      return res.status(400).json({ message: "Le mot de passe doit comporter entre 10 et 128 caractères" });
    }

    const user = await User.create({
      username,
      email,
      password: await bcrypt.hash(password, 10),
      role: "staff",
      isActive: false,
    });
    await recordAudit({ req, actor: user, action: "USER_REGISTERED", targetType: "User", targetId: user._id, after: { username, email, role: "staff", isActive: false } });

    return res.status(201).json({
      pendingActivation: true,
      message: "Compte créé. Un administrateur doit l'activer avant la première connexion.",
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Cet email est déjà utilisé" });
    }
    console.error("Error registering user:", error?.name || "Error");
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/login", loginThrottleGuard, async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  try {
    if (!email || !password || email.length > 254 || password.length > 128 || !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ message: "Missing credentials" });
    }

    const user = await User.findOne({ email }).select("+password +tokenVersion");
    // Unknown email and wrong password are indistinguishable to the caller.
    const ok = await bcrypt.compare(password, user?.password || DUMMY_HASH);
    if (!user || !ok) {
      const { accountLocked, ipLocked } = await recordLoginFailure(req, email);
      await recordAudit({ req, actor: user || { username: email }, action: "LOGIN_FAILED", outcome: "failure", targetType: "User", targetId: user?._id, details: { email } });
      if (accountLocked || ipLocked) {
        await recordAudit({ req, actor: user || { username: email }, action: "LOGIN_LOCKOUT", outcome: "failure", targetType: "User", targetId: user?._id, details: { email, scope: accountLocked ? "account" : "ip" } });
      }
      return res.status(401).json(INVALID_CREDENTIALS);
    }

    // Only someone who knows the password learns that the account is inactive.
    if (!user.isActive) {
      return res.status(403).json({ code: "ACCOUNT_DISABLED", message: "Votre compte est désactivé ou en attente d'activation. Contactez un administrateur." });
    }

    await recordLoginSuccess(req, email);
    const token = generateToken(user);
    console.log("User logged in:", user._id.toString());
    return res.status(200).json({ user: safeUser(user), token });
  } catch (error) {
    console.error("Error logging in user:", error?.name || "Error");
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Ends this session server-side: the token's id is revoked until it expires.
router.post("/logout", authMiddleware, async (req, res) => {
  try {
    const { jti, exp } = req.auth || {};
    if (jti && exp) {
      await RevokedToken.updateOne(
        { jti },
        { $setOnInsert: { jti, userId: req.user._id, expiresAt: new Date(exp * 1000) } },
        { upsert: true }
      );
    }
    await recordAudit({ req, action: "LOGOUT", targetType: "User", targetId: req.user._id });
    return res.json({ success: true });
  } catch (error) {
    console.error("Error logging out:", error?.name || "Error");
    return res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
