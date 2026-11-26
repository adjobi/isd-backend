// Vérification d'identité des prestataires (facultative, mise en avant) :
//   POST /api/identity  { docType, document, selfie } → demande (nounou / répétiteur, 3 envois par 24 h)
//   GET  /api/identity  → statut de vérification et dernière demande
// Corps limité à 900 Ko (deux photos de 300 Ko en base64), lu seulement APRÈS authentification, contrôle
// du rôle et limiteur (10 tentatives par heure et par compte, valides ou non) : voir middleware/bodyParsing.js.
// La décision (validation, refus) est prise dans l'Espace ISD (routes/adminRoutes.js).
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const requireRole = require("../middleware/requireRole");
const User = require("../models/User");
const IdentityCheck = require("../models/IdentityCheck");
const { encryptIdentity } = require("../utils/identityCrypto");
const { identityJson } = require("../middleware/bodyParsing");
const { MAX_PER_DAY, DAY_MS, validateSubmission, serializeCheck } = require("../services/identity");

// Toutes les tentatives comptent (corps invalide, trop lourd, refus…), par compte.
const identityLimiter = require("../middleware/rateLimit")({
  windowMs: 60 * 60 * 1000,
  max: 10,
  key: (req) => (req.user?.id ? `user:${req.user.id}` : null),
  message: "Trop de tentatives d'envoi. Réessayez dans une heure.",
});

const PENDING = "Une vérification est déjà en cours.";
const TOO_MANY = "Vous avez déjà envoyé 3 demandes en 24 h. Réessayez demain.";

router.post("/", auth, requireRole("nanny", "tutor"), identityLimiter, identityJson, async (req, res) => {
  try {
    const input = validateSubmission(req.body);
    if (input.errors) return res.status(400).json({ message: "Merci de corriger les champs en surbrillance", errors: input.errors });

    const user = await User.findById(req.user.id).select("role isVerified firstName lastName").lean();
    if (!user) return res.status(401).json({ message: "Session expirée : reconnectez-vous." });
    if (!["nanny", "tutor"].includes(user.role)) return res.status(403).json({ message: "Accès non autorisé pour ce profil" });
    if (user.isVerified) return res.status(409).json({ message: "Votre identité est déjà vérifiée." });
    if (await IdentityCheck.exists({ user: req.user.id, status: "pending" })) return res.status(409).json({ message: PENDING });
    const since = new Date(Date.now() - DAY_MS);
    if (await IdentityCheck.countDocuments({ user: req.user.id, submittedAt: { $gte: since } }) >= MAX_PER_DAY) {
      return res.status(429).json({ message: TOO_MANY });
    }

    // Jamais d'image en clair en base : sans clé de chiffrement, on refuse la demande.
    // L'identifiant est créé d'abord : il sert de données associées au chiffrement (AAD).
    const _id = new mongoose.Types.ObjectId();
    const document = encryptIdentity(input.document, _id, "document");
    const selfie = encryptIdentity(input.selfie, _id, "selfie");
    if (!document || !selfie) return res.status(503).json({ message: "Vérification indisponible pour le moment. Réessayez plus tard." });

    let check;
    try {
      // Nom du profil figé à l'envoi : la validation est annulée s'il change entre-temps.
      check = await IdentityCheck.create({
        _id, user: req.user.id, firstName: user.firstName || "", lastName: user.lastName || "",
        docType: input.docType, document, selfie, submittedAt: new Date(),
      });
    } catch (err) {
      // Index unique partiel : deux envois simultanés → une seule demande en attente.
      if (err?.code === 11000) return res.status(409).json({ message: PENDING });
      throw err;
    }
    const { status, docType, docTypeLabel, submittedAt } = serializeCheck(check);
    return res.status(201).json({
      message: "Demande envoyée. L'équipe ISD vérifie vos photos ; elles seront supprimées dès la décision.",
      check: { status, docType, docTypeLabel, submittedAt },
    });
  } catch (err) {
    console.error("POST /identity", err);
    return res.status(500).json({ message: "Envoi impossible pour le moment. Réessayez." });
  }
});

router.get("/", auth, async (req, res) => {
  try {
    const [user, check] = await Promise.all([
      User.findById(req.user.id).select("isVerified verifiedAt").lean(),
      IdentityCheck.findOne({ user: req.user.id }).sort({ submittedAt: -1 })
        .select("status docType submittedAt decidedAt rejectReason").lean(),
    ]);
    if (!user) return res.status(404).json({ message: "Compte introuvable" });
    return res.json({ verified: !!user.isVerified, verifiedAt: user.isVerified ? user.verifiedAt || null : null, check: serializeCheck(check) });
  } catch (err) {
    console.error("GET /identity", err);
    return res.status(500).json({ message: "Impossible de charger votre vérification. Réessayez." });
  }
});

module.exports = router;
module.exports.identityLimiter = identityLimiter;
