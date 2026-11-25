// Double authentification des comptes de l'équipe ISD (monté sur /api/auth) :
//   POST /login/2fa            étape « code » de la connexion (public, jeton d'étape requis)
//   GET  /2fa                  état (activée, codes de secours restants)
//   POST /2fa/setup            { password } → nouvelle clé + QR code (pas encore active)
//   POST /2fa/enable           { code } → active, renvoie les codes de secours et une session vérifiée
//   POST /2fa/recovery-codes   { code } → nouveaux codes de secours (les anciens ne marchent plus)
//   POST /2fa/disable          { password, code } → désactive
const express = require("express");
const bcrypt = require("bcryptjs");
const QRCode = require("qrcode");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const AdminLog = require("../models/AdminLog");
const User = require("../models/User");
const twoFactor = require("../services/twoFactor");
const throttle = require("../services/loginThrottle");
const { loginTwoFactor, session } = require("../controllers/authController");

router.post("/login/2fa", loginTwoFactor);

const fail = (res, where, err) => {
  console.error(where, err);
  return res.status(500).json({ message: "Erreur serveur. Réessayez dans un instant." });
};

// Compte de l'équipe ISD, avec ses secrets (jamais renvoyés tels quels).
async function teamUser(req, res) {
  const user = await twoFactor.loadSecrets(req.user.id);
  if (!user) { res.status(401).json({ message: "Session expirée : reconnectez-vous." }); return null; }
  if (!user.isAdmin) { res.status(403).json({ message: "Réservé à l'équipe ISD." }); return null; }
  return user;
}

// Mot de passe redemandé pour les changements sensibles (limité comme la connexion).
async function passwordOk(req, res, user) {
  const ip = req.ip || "inconnue";
  const wait = throttle.check(ip, user.email);
  if (wait) {
    res.set("Retry-After", String(wait));
    res.status(429).json({ message: `Trop de tentatives. Réessayez dans ${Math.ceil(wait / 60)} min.` });
    return false;
  }
  throttle.attempt(ip);
  const full = await User.findById(user._id).select("password");
  const ok = !!full && typeof req.body?.password === "string" && (await bcrypt.compare(req.body.password, full.password));
  if (!ok) {
    throttle.failure(user.email);
    res.status(401).json({ message: "Mot de passe incorrect.", errors: { password: "Mot de passe incorrect" } });
    return false;
  }
  return true;
}

async function codeOk(req, res, user) {
  const ip = req.ip || "inconnue";
  const wait = throttle.check(ip, user.email);
  if (wait) {
    res.set("Retry-After", String(wait));
    res.status(429).json({ message: `Trop de codes faux. Réessayez dans ${Math.ceil(wait / 60)} min.` });
    return false;
  }
  throttle.attempt(ip);
  if (!(await twoFactor.checkCode(user, req.body?.code))) {
    throttle.failure(user.email);
    res.status(401).json({ message: "Code incorrect ou déjà utilisé.", errors: { code: "Code incorrect ou déjà utilisé" } });
    return false;
  }
  return true;
}

const log = (req, user, action) =>
  AdminLog.create({ admin: user._id, action, ip: req.ip || "" }).catch((e) => console.error("journal 2fa", e.message));

router.get("/2fa", authMiddleware, async (req, res) => {
  try {
    const user = await teamUser(req, res);
    if (!user) return;
    return res.json({
      enabled: !!user.twoFactorEnabled,
      required: twoFactor.adminRequires2fa(),
      recoveryCodesLeft: user.twoFactorEnabled ? (user.twoFactor?.recoveryCodes || []).length : 0,
      enabledAt: user.twoFactor?.enabledAt || null,
    });
  } catch (err) { return fail(res, "GET /auth/2fa", err); }
});

router.post("/2fa/setup", authMiddleware, async (req, res) => {
  try {
    const user = await teamUser(req, res);
    if (!user) return;
    if (user.twoFactorEnabled) return res.status(409).json({ message: "La double authentification est déjà active." });
    if (!(await passwordOk(req, res, user))) return;
    const { secret, otpauthUrl } = await twoFactor.startSetup(user);
    const qr = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240, errorCorrectionLevel: "M" });
    return res.json({ secret, otpauthUrl, qr });
  } catch (err) { return fail(res, "POST /auth/2fa/setup", err); }
});

router.post("/2fa/enable", authMiddleware, async (req, res) => {
  try {
    const user = await teamUser(req, res);
    if (!user) return;
    if (user.twoFactorEnabled) return res.status(409).json({ message: "La double authentification est déjà active." });
    const r = await twoFactor.enable(user, req.body?.code);
    if (r.error === "start") return res.status(409).json({ message: "Recommencez l'activation depuis le début." });
    if (r.error === "code") {
      return res.status(400).json({ message: "Code incorrect : vérifiez l'heure du téléphone et saisissez le code affiché.", errors: { code: "Code incorrect" } });
    }
    await log(req, user, "2fa_enabled");
    user.twoFactorEnabled = true;
    // Le code vient d'être vérifié : nouvelle session « vérifiée » (12 h, comme l'Espace ISD).
    const s = session(user, { team: true, mfa: true });
    return res.json({ message: "Double authentification activée.", recoveryCodes: r.codes, token: s.token, user: s.user });
  } catch (err) { return fail(res, "POST /auth/2fa/enable", err); }
});

router.post("/2fa/recovery-codes", authMiddleware, async (req, res) => {
  try {
    const user = await teamUser(req, res);
    if (!user) return;
    if (!user.twoFactorEnabled) return res.status(409).json({ message: "La double authentification n'est pas active." });
    if (!(await codeOk(req, res, user))) return;
    const codes = await twoFactor.newRecoveryCodes(user);
    await log(req, user, "2fa_recovery_codes");
    return res.json({ message: "Nouveaux codes de secours créés. Les anciens ne fonctionnent plus.", recoveryCodes: codes });
  } catch (err) { return fail(res, "POST /auth/2fa/recovery-codes", err); }
});

router.post("/2fa/disable", authMiddleware, async (req, res) => {
  try {
    const user = await teamUser(req, res);
    if (!user) return;
    if (!user.twoFactorEnabled) return res.status(409).json({ message: "La double authentification n'est pas active." });
    if (!(await passwordOk(req, res, user))) return;
    if (!(await codeOk(req, res, user))) return;
    await twoFactor.disable(user);
    await log(req, user, "2fa_disabled");
    return res.json({ message: "Double authentification désactivée." });
  } catch (err) { return fail(res, "POST /auth/2fa/disable", err); }
});

module.exports = router;
