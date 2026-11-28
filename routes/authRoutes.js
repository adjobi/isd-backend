const express = require("express");
const router = express.Router();
const { register, login } = require("../controllers/authController");
const authMiddleware = require("../middleware/authMiddleware");
const User = require("../models/User");
const IdentityCheck = require("../models/IdentityCheck");
const { validateProfile, hasContactError } = require("../validators/profile");
const { recordContactStrike } = require("../services/moderation");
// Modifications de profil limitées par compte (anti-abus, essais répétés de coordonnées).
const profileLimiter = require("../middleware/rateLimit")({
  windowMs: 60 * 60 * 1000,
  max: 30,
  key: (req) => req.user?.id,
  message: "Trop de modifications du profil en peu de temps. Réessayez dans une heure.",
});
const { NAME_CHANGED_REASON, rejectPendingUpdate } = require("../services/identity");

// ======================
// AUTH PUBLIC
// ======================
// Inscriptions limitées par adresse IP (contre la création de comptes en masse).
const registerLimiter = require("../middleware/rateLimit")({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: "Trop d'inscriptions depuis cette connexion. Réessayez dans une heure.",
});
router.post("/register", registerLimiter, register);
router.post("/login", login);

// ======================
// AUTH PROTECTED
// ======================
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password").lean();
    if (!user) return res.status(404).json({ message: "Compte introuvable" });
    return res.json({ message: "Utilisateur connecté", user: { ...user, id: user._id } });
  } catch (err) {
    console.error("GET /auth/me", err);
    return res.status(500).json({ message: "Impossible de charger le profil. Réessayez." });
  }
});

// ======================
// METTRE À JOUR DISPONIBILITÉ
// ======================
router.put("/availability", authMiddleware, async (req, res) => {
  try {
    const { availability } = req.body;
    if (!["available", "busy", "away"].includes(availability)) {
      return res.status(400).json({ message: "Statut invalide" });
    }
    await User.findByIdAndUpdate(req.user.id, { availability });
    return res.json({ message: "Disponibilité mise à jour" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ======================
// METTRE À JOUR LE PROFIL ENRICHI
// ======================
// Corps limité à 450 Ko (photo de 300 Ko max en base64) : voir PROFILE_BODY_LIMIT dans server.js.
router.put("/profile", authMiddleware, profileLimiter, async (req, res) => {
  try {
    const { updates, errors } = validateProfile(req.body, req.user.role);
    if (hasContactError(errors)) await recordContactStrike(req.user.id, "profile");
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ message: "Merci de corriger les champs en surbrillance", errors });
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "Aucune modification à enregistrer" });
    }
    // Nom, prénom ou photo réellement modifiés : le badge « Vérifié » ne vaut plus. Il est retiré dans la
    // MÊME écriture que l'enregistrement du profil (jamais avant, jamais en tâche détachée).
    const nameTouched = updates.firstName !== undefined || updates.lastName !== undefined;
    const photoTouched = updates.photo !== undefined;
    let nameChanged = false;
    let photoChanged = false;
    let wasVerified = false;
    if (nameTouched || photoTouched) {
      const current = await User.findById(req.user.id).select(`firstName lastName isVerified${photoTouched ? " photo" : ""}`).lean();
      if (!current) return res.status(404).json({ message: "Compte introuvable" });
      wasVerified = !!current.isVerified;
      nameChanged = (updates.firstName !== undefined && updates.firstName !== current.firstName)
        || (updates.lastName !== undefined && updates.lastName !== current.lastName);
      photoChanged = photoTouched && (updates.photo || "") !== (current.photo || "");
    }
    const write = { $set: { ...updates } };
    if (nameChanged || photoChanged) {
      write.$set.isVerified = false;
      write.$unset = { verifiedAt: 1 };
    }
    const user = await User.findByIdAndUpdate(req.user.id, write, { new: true, runValidators: true })
      .select("-password")
      .lean();
    if (!user) return res.status(404).json({ message: "Compte introuvable" });
    // Photo antérieure à la date de version : on la date maintenant pour son adresse publique.
    if (user.photo && !user.photoUpdatedAt) {
      user.photoUpdatedAt = new Date();
      await User.updateOne({ _id: user._id }, { $set: { photoUpdatedAt: user.photoUpdatedAt } });
    }
    // Nouveau nom : une demande de vérification en attente porte l'ancien nom, elle est annulée.
    let identityCancelled = false;
    if (nameChanged) {
      const r = await IdentityCheck.updateMany({ user: user._id, status: "pending" }, rejectPendingUpdate(NAME_CHANGED_REASON));
      identityCancelled = (r.modifiedCount || 0) > 0;
    }
    const body = { message: "Profil mis à jour", user: { ...user, id: user._id } };
    if (identityCancelled) body.notice = `${NAME_CHANGED_REASON}.`;
    else if ((nameChanged || photoChanged) && wasVerified) {
      body.notice = "Profil modifié : refaites la vérification d'identité pour retrouver le badge « Identité vérifiée ».";
    }
    return res.json(body);
  } catch (err) {
    console.error("PUT /auth/profile", err);
    return res.status(500).json({ message: "Impossible d’enregistrer le profil. Réessayez." });
  }
});

module.exports = router;
module.exports.registerLimiter = registerLimiter;
