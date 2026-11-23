const express = require("express");
const router = express.Router();
const { register, login } = require("../controllers/authController");
const authMiddleware = require("../middleware/authMiddleware");
const User = require("../models/User");
const { validateProfile } = require("../validators/profile");

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
router.put("/profile", authMiddleware, async (req, res) => {
  try {
    const { updates, errors } = validateProfile(req.body, req.user.role);
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ message: "Merci de corriger les champs en surbrillance", errors });
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "Aucune modification à enregistrer" });
    }
    const user = await User.findByIdAndUpdate(req.user.id, { $set: updates }, { new: true, runValidators: true })
      .select("-password")
      .lean();
    if (!user) return res.status(404).json({ message: "Compte introuvable" });
    return res.json({ message: "Profil mis à jour", user: { ...user, id: user._id } });
  } catch (err) {
    console.error("PUT /auth/profile", err);
    return res.status(500).json({ message: "Impossible d’enregistrer le profil. Réessayez." });
  }
});

module.exports = router;
module.exports.registerLimiter = registerLimiter;
