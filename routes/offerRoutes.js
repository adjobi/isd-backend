const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const Offer = require("../models/Offer");

// ================================
// CRÉER UNE OFFRE (famille only)
// ================================
router.post("/", auth, async (req, res) => {
  try {
    if (req.user.role !== "family") {
      return res.status(403).json({ message: "Réservé aux familles" });
    }
    const { serviceType, description, duration, price, subjects, city } = req.body;
    if (!serviceType || !description || !duration || !city) {
      return res.status(400).json({ message: "Champs obligatoires manquants" });
    }
    const offer = await Offer.create({
      family: req.user.id,
      serviceType,
      description,
      duration,
      price: price || 0,
      subjects: subjects || [],
      city,
    });
    return res.status(201).json({ message: "Offre créée", offer });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ================================
// MES OFFRES (famille)
// ================================
router.get("/my", auth, async (req, res) => {
  try {
    const offers = await Offer.find({ family: req.user.id })
      .populate("applications.provider", "firstName lastName city serviceType pricingAmount rating photo")
      .sort({ createdAt: -1 });
    return res.json(offers);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ================================
// OFFRES DISPONIBLES (prestataires)
// Filtre par serviceType du prestataire
// ================================
router.get("/available", auth, async (req, res) => {
  try {
    const role = req.user.role; // nanny ou tutor
    if (role === "family") {
      return res.status(403).json({ message: "Réservé aux prestataires" });
    }
    const offers = await Offer.find({
      serviceType: role,
      status: "open",
    })
      .populate("family", "firstName lastName city")
      .sort({ createdAt: -1 });
    return res.json(offers);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ================================
// CANDIDATER À UNE OFFRE (prestataire)
// ================================
router.post("/:id/apply", auth, async (req, res) => {
  try {
    const role = req.user.role;
    if (role === "family") {
      return res.status(403).json({ message: "Réservé aux prestataires" });
    }
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (offer.status === "closed") {
      return res.status(400).json({ message: "Cette offre est fermée" });
    }
    // Vérifier si déjà candidaté
    const already = offer.applications.find(
      (a) => a.provider.toString() === req.user.id
    );
    if (already) {
      return res.status(400).json({ message: "Vous avez déjà candidaté" });
    }
    offer.applications.push({ provider: req.user.id });
    await offer.save();
    return res.json({ message: "Candidature envoyée" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ================================
// ACCEPTER UNE CANDIDATURE (famille)
// Refuse automatiquement les autres
// ================================
router.post("/:offerId/accept/:providerId", auth, async (req, res) => {
  try {
    if (req.user.role !== "family") {
      return res.status(403).json({ message: "Réservé aux familles" });
    }
    const offer = await Offer.findById(req.params.offerId);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (offer.family.toString() !== req.user.id) {
      return res.status(403).json({ message: "Non autorisé" });
    }

    // Accepter le candidat choisi, refuser tous les autres
    offer.applications = offer.applications.map((a) => ({
      ...a.toObject(),
      status:
        a.provider.toString() === req.params.providerId ? "accepted" : "rejected",
    }));

    // Fermer l'offre
    offer.status = "closed";
    await offer.save();

    return res.json({ message: "Candidature acceptée, offre fermée", offer });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ================================
// REFUSER UNE CANDIDATURE (famille)
// ================================
router.post("/:offerId/reject/:providerId", auth, async (req, res) => {
  try {
    if (req.user.role !== "family") {
      return res.status(403).json({ message: "Réservé aux familles" });
    }
    const offer = await Offer.findById(req.params.offerId);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });

    const app = offer.applications.find(
      (a) => a.provider.toString() === req.params.providerId
    );
    if (!app) return res.status(404).json({ message: "Candidature introuvable" });

    app.status = "rejected";
    await offer.save();

    return res.json({ message: "Candidature refusée" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;
