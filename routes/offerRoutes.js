const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const Offer = require("../models/Offer");
const Notification = require("../models/Notification");

// ================================
// CRÉER UNE OFFRE (famille only)
// Si targetProvider est fourni : offre privée/directe,
// avec candidature automatique du prestataire ciblé.
// ================================
router.post("/", auth, async (req, res) => {
  try {
    if (req.user.role !== "family") {
      return res.status(403).json({ message: "Réservé aux familles" });
    }
    const { serviceType, description, duration, price, subjects, city, targetProvider } = req.body;
    if (!serviceType || !description || !duration || !city) {
      return res.status(400).json({ message: "Champs obligatoires manquants" });
    }

    const offerData = {
      family: req.user.id,
      serviceType, description, duration,
      price: price || 0,
      subjects: subjects || [],
      city,
    };

    if (targetProvider) {
      offerData.targetProvider = targetProvider;
      // Offre directe : le prestataire ciblé est automatiquement "candidat"
      // pour que le flux d'acceptation existant (accept/:offerId/:providerId) fonctionne sans changement.
      offerData.applications = [{ provider: targetProvider, status: "pending" }];
    }

    const offer = await Offer.create(offerData);

    if (targetProvider) {
      await Notification.create({
        userId: targetProvider,
        title: "Nouvelle proposition directe",
        message: "Une famille vous propose directement une collaboration. Consultez l'offre pour accepter ou refuser.",
        type: "booking_request",
        metadata: { offerId: offer._id },
      });
    }

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
// Inclut : les offres publiques ouvertes (targetProvider absent)
// + les offres privées ciblant CE prestataire précis
// ================================
router.get("/available", auth, async (req, res) => {
  try {
    const role = req.user.role;
    if (role === "family") {
      return res.status(403).json({ message: "Réservé aux prestataires" });
    }
    const offers = await Offer.find({
      serviceType: role,
      status: "open",
      $or: [
        { targetProvider: null },
        { targetProvider: req.user.id },
      ],
    })
      .populate("family", "firstName lastName city")
      .sort({ createdAt: -1 });
    return res.json(offers);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ================================
// MES CANDIDATURES (prestataire)
// Toutes les offres où j'ai candidaté (ou été ciblé directement)
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
        isDirectOffer: !!offer.targetProvider,
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
// CANDIDATER / ACCEPTER UNE OFFRE (prestataire)
//
// - Offre PUBLIQUE : crée une nouvelle candidature (comportement inchangé).
// - Offre DIRECTE (targetProvider) : une candidature "pending" existe déjà
//   automatiquement depuis la création. Ici, le prestataire confirme son
//   intérêt -> on notifie la famille pour qu'elle valide via /accept.
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
    if (offer.targetProvider && offer.targetProvider.toString() !== req.user.id) {
      return res.status(403).json({ message: "Cette offre est réservée à un autre prestataire" });
    }

    const already = offer.applications.find(
      (a) => a.provider.toString() === req.user.id
    );

    const isDirectOffer = !!offer.targetProvider;

    if (already) {
      // Cas attendu pour une offre directe : la candidature existe déjà
      // automatiquement depuis la création. On confirme l'intérêt du
      // prestataire et on notifie la famille, sans renvoyer d'erreur.
      if (isDirectOffer && already.status === "pending") {
        await Notification.create({
          userId: offer.family,
          title: "Prestataire intéressé",
          message: "Le prestataire confirme son intérêt pour votre proposition directe. Validez sa candidature pour ouvrir le chat.",
          type: "booking_request",
          metadata: { offerId: offer._id },
        });
        return res.json({ message: "Intérêt confirmé, la famille va valider votre candidature" });
      }
      return res.status(400).json({ message: "Vous avez déjà candidaté" });
    }

    offer.applications.push({ provider: req.user.id });
    await offer.save();

    // Notifier la famille qu'une nouvelle candidature est arrivée
    await Notification.create({
      userId: offer.family,
      title: "Nouvelle candidature",
      message: "Un prestataire a candidaté à votre offre.",
      type: "booking_request",
      metadata: { offerId: offer._id },
    });

    return res.json({ message: "Candidature envoyée" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ================================
// RETIRER MA CANDIDATURE (prestataire)
// Possible uniquement si elle n'a pas encore été acceptée par la famille
// (une candidature acceptée correspond à une collaboration en cours,
// qui se gère via l'annulation de réservation, pas un simple retrait).
// ================================
router.delete("/:id/withdraw", auth, async (req, res) => {
  try {
    const role = req.user.role;
    if (role === "family") {
      return res.status(403).json({ message: "Réservé aux prestataires" });
    }
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });

    const appIndex = offer.applications.findIndex(
      (a) => a.provider.toString() === req.user.id
    );
    if (appIndex === -1) {
      return res.status(404).json({ message: "Candidature introuvable" });
    }

    const app = offer.applications[appIndex];
    if (app.status === "accepted") {
      return res.status(400).json({
        message: "Impossible de retirer une candidature déjà acceptée. Utilisez plutôt la rupture de collaboration.",
      });
    }

    offer.applications.splice(appIndex, 1);
    await offer.save();

    return res.json({ message: "Candidature retirée" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ================================
// REFUSER UNE OFFRE DIRECTE (prestataire)
// Le prestataire ciblé peut refuser une proposition directe
// ================================
router.post("/:id/decline", auth, async (req, res) => {
  try {
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (!offer.targetProvider || offer.targetProvider.toString() !== req.user.id) {
      return res.status(403).json({ message: "Non autorisé" });
    }
    const app = offer.applications.find(
      (a) => a.provider.toString() === req.user.id
    );
    if (app) app.status = "rejected";
    offer.status = "closed";
    await offer.save();

    await Notification.create({
      userId: offer.family,
      title: "Proposition refusée",
      message: "Le prestataire a décliné votre proposition directe.",
      type: "booking_rejected",
      metadata: { offerId: offer._id },
    });

    return res.json({ message: "Proposition refusée" });
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

    const acceptedProviderId = req.params.providerId;
    const rejectedProviderIds = [];

    offer.applications = offer.applications.map((a) => {
      const providerIdStr = a.provider.toString();
      const isAccepted = providerIdStr === acceptedProviderId;
      if (!isAccepted) rejectedProviderIds.push(providerIdStr);
      return {
        ...a.toObject(),
        status: isAccepted ? "accepted" : "rejected",
      };
    });
    offer.status = "closed";
    await offer.save();

    // Notifier le prestataire accepté
    await Notification.create({
      userId: acceptedProviderId,
      title: "Candidature acceptée 🎉",
      message: "Votre candidature a été acceptée ! Vous pouvez maintenant échanger avec la famille dans le chat.",
      type: "booking_accepted",
      metadata: { offerId: offer._id },
    });

    // Notifier les prestataires refusés
    for (const providerId of rejectedProviderIds) {
      await Notification.create({
        userId: providerId,
        title: "Candidature non retenue",
        message: "La famille a sélectionné un autre prestataire pour cette offre.",
        type: "booking_rejected",
        metadata: { offerId: offer._id },
      });
    }

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

    await Notification.create({
      userId: req.params.providerId,
      title: "Candidature non retenue",
      message: "La famille n'a pas retenu votre candidature pour cette offre.",
      type: "booking_rejected",
      metadata: { offerId: offer._id },
    });

    return res.json({ message: "Candidature refusée" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;
