// Double authentification : étape « code » de la connexion, vérification d'un code (application
// d'authentification ou code de secours), règle d'accès à l'Espace ISD.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const totp = require("../utils/totp");
const { encrypt, decrypt } = require("../utils/crypto");
const { isProd } = require("../config/env");

const CHALLENGE_TTL = "5m";

// Le jeton d'étape « code » est signé avec une clé dérivée : il ne peut jamais servir de jeton de session.
const challengeKey = () => crypto.createHmac("sha256", String(process.env.JWT_SECRET || "")).update("isd-2fa-challenge").digest("hex");

const signChallenge = (user, { team = false } = {}) =>
  jwt.sign({ id: String(user._id), team: !!team }, challengeKey(), { expiresIn: CHALLENGE_TTL });

function readChallenge(token) {
  try {
    const d = jwt.verify(String(token || ""), challengeKey());
    return d?.id ? d : null;
  } catch {
    return null;
  }
}

// En production, l'Espace ISD exige la double authentification. En local, seulement si ADMIN_2FA=required
// (ou si le compte l'a activée : le code est alors toujours demandé).
const adminRequires2fa = () => isProd() || process.env.ADMIN_2FA === "required";

const loadSecrets = (userId) => User.findById(userId).select("+twoFactor email isAdmin twoFactorEnabled");

// Vérifie un code pour un compte dont la double authentification est active.
// Met à jour le dernier code utilisé (pas de rejeu) ou consomme le code de secours.
// Renvoie "totp", "recovery" ou null.
async function checkCode(user, code) {
  const tf = user.twoFactor;
  if (!user.twoFactorEnabled || !tf?.secret) return null;
  const raw = String(code || "").trim();
  if (/^\d[\d\s]*$/.test(raw)) {
    const secret = decrypt(tf.secret);
    const step = secret ? totp.verify(secret, raw, { afterStep: tf.lastStep ?? -1 }) : null;
    if (step === null) return null;
    // Mise à jour conditionnelle : deux requêtes simultanées avec le même code ne passent pas toutes les deux.
    const r = await User.updateOne(
      { _id: user._id, "twoFactor.lastStep": { $lt: step } },
      { $set: { "twoFactor.lastStep": step } }
    );
    return r.modifiedCount === 1 ? "totp" : null;
  }
  if (totp.normalizeRecovery(raw).length !== 8) return null;
  const hash = totp.hashRecovery(raw);
  if (!(tf.recoveryCodes || []).includes(hash)) return null;
  const r = await User.updateOne(
    { _id: user._id, "twoFactor.recoveryCodes": hash },
    { $pull: { "twoFactor.recoveryCodes": hash } }
  );
  return r.modifiedCount === 1 ? "recovery" : null;
}

// Nouvelle clé en attente d'activation (la clé active, s'il y en a une, n'est pas touchée).
async function startSetup(user) {
  const secret = totp.generateSecret();
  const stored = encrypt(secret);
  if (!stored) throw new Error("CHAT_ENCRYPTION_KEY manquante : impossible de protéger la clé");
  await User.updateOne({ _id: user._id }, { $set: { "twoFactor.pendingSecret": stored } });
  return { secret, otpauthUrl: totp.otpauthUrl(secret, user.email) };
}

// Active la clé en attente si le code est bon. Renvoie les codes de secours (en clair, une seule fois).
async function enable(user, code) {
  const pending = user.twoFactor?.pendingSecret ? decrypt(user.twoFactor.pendingSecret) : null;
  if (!pending) return { error: "start" };
  const step = totp.verify(pending, code);
  if (step === null) return { error: "code" };
  const codes = totp.generateRecoveryCodes();
  await User.updateOne({ _id: user._id }, {
    $set: {
      twoFactorEnabled: true,
      twoFactor: { secret: user.twoFactor.pendingSecret, lastStep: step, recoveryCodes: codes.map(totp.hashRecovery), enabledAt: new Date() },
    },
  });
  return { codes };
}

async function newRecoveryCodes(user) {
  const codes = totp.generateRecoveryCodes();
  await User.updateOne({ _id: user._id }, { $set: { "twoFactor.recoveryCodes": codes.map(totp.hashRecovery) } });
  return codes;
}

async function disable(user) {
  await User.updateOne({ _id: user._id }, { $set: { twoFactorEnabled: false }, $unset: { twoFactor: 1 } });
}

module.exports = { signChallenge, readChallenge, adminRequires2fa, loadSecrets, checkCode, startSetup, enable, newRecoveryCodes, disable };
