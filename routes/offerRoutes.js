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
      serviceType, description, duration,
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
// ================================
router.get("/available", auth, async (req, res) => {
  try {
    const role = req.user.role;
    if (role === "family") {
      return res.status(403).json({ message: "Réservé aux prestataires" });
    }
    const offers = await Offer.find({ serviceType: role, status: "open" })
      .populate("family", "firstName lastName city")
      .sort({ createdAt: -1 });
    return res.json(offers);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ================================
// MES CANDIDATURES (prestataire)
// Toutes les offres où j'ai candidaté
// peu importe le statut de l'offre
// ================================
router.get("/my-applications", auth, async (req, res) => {
  try {
    const role = req.user.role;
    if (role === "family") {
      return res.status(403).json({ message: "Réservé aux prestataires" });
    }
    const offers = await Offer.find({
      "applications.provider": req.user.id,
    })
      .populate("family", "firstName lastName city phone")
      .sort({ createdAt: -1 });

    // Ajouter le statut de MA candidature dans chaque offre
    const result = offers.map((offer) => {
      const myApp = offer.applications.find(
        (a) => a.provider.toString() === req.user.id
      );
      return {
        ...offer.toObject(),
        myApplication: myApp,
      };
    });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ================================
// MODIFIER UNE OFFRE (famille)
// ================================
router.put("/:id", auth, async (req, res) => {
  try {
    if (req.user.role !== "family") {
      return res.status(403).json({ message: "Réservé aux familles" });
    }
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (offer.family.toString() !== req.user.id) {
      return res.status(403).json({ message: "Non autorisé" });
    }
    if (offer.status === "closed") {
      return res.status(400).json({ message: "Impossible de modifier une offre fermée" });
    }
    const { description, duration, price, subjects, city } = req.body;
    if (description) offer.description = description;
    if (duration) offer.duration = duration;
    if (price !== undefined) offer.price = price;
    if (subjects) offer.subjects = subjects;
    if (city) offer.city = city;
    await offer.save();
    return res.json({ message: "Offre modifiée", offer });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ================================
// ANNULER UNE OFFRE (famille)
// ================================
router.put("/:id/cancel", auth, async (req, res) => {
  try {
    if (req.user.role !== "family") {
      return res.status(403).json({ message: "Réservé aux familles" });
    }
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (offer.family.toString() !== req.user.id) {
      return res.status(403).json({ message: "Non autorisé" });
    }
    offer.status = "closed";
    await offer.save();
    return res.json({ message: "Offre annulée" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ================================
// SUPPRIMER UNE OFFRE (famille)
// ================================
router.delete("/:id", auth, async (req, res) => {
  try {
    if (req.user.role !== "family") {
      return res.status(403).json({ message: "Réservé aux familles" });
    }
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (offer.family.toString() !== req.user.id) {
      return res.status(403).json({ message: "Non autorisé" });
    }
    await offer.deleteOne();
    return res.json({ message: "Offre supprimée" });
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
    offer.applications = offer.applications.map((a) => ({
      ...a.toObject(),
      status: a.provider.toString() === req.params.providerId ? "accepted" : "rejected",
    }));
    offer.status = "closed";
    await offer.save();
    return res.json({ message: "Candidature acceptée", offer });
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
