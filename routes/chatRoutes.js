const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { ChatMessage, ChatSession } = require("../models/Chat");
const Offer = require("../models/Offer");
const User = require("../models/User");
const Notification = require("../models/Notification");
const Booking = require("../models/Booking");

// ================================
// CONFIG ISD
// ================================
const ISD_MOBILE_MONEY_NUMBER = "+225 07 09 10 25 24";
const ISD_COMMISSION_RATE = 0.2; // 20% du tarif du prestataire

function computeInvoiceAmount(pricingAmount) {
  const raw = (pricingAmount || 0) * ISD_COMMISSION_RATE;
  return Math.round(raw / 100) * 100; // arrondi au multiple de 100 le plus proche
}

// ================================
// PATTERNS INFOS SENSIBLES
// ================================
const SENSITIVE_PATTERNS = [
  // Numéros de téléphone (formats CI, international)
  /(\+?225?\s?)?(\d[\s\-.]?){8,10}/g,
  // Email
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  // Facebook / Messenger / WhatsApp / Instagram
  /(facebook|messenger|whatsapp|instagram|telegram|twitter|snapchat|tiktok)/gi,
  // Liens
  /(https?:\/\/|www\.)[^\s]+/gi,
];

const WARNING_MESSAGES = [
  "⚠️ ISD Système : Le partage de coordonnées personnelles est interdit. Merci de respecter nos conditions.",
  "⚠️ ISD Système : Ce message contient des informations interdites et a été masqué. Dernier avertissement.",
  "🚫 ISD Système : Vous avez persisté à partager des informations interdites. Ce chat est fermé conformément à nos conditions d'utilisation.",
];

function detectAndCensor(text) {
  let censored = text;
  let hasViolation = false;
  SENSITIVE_PATTERNS.forEach((pattern) => {
    if (pattern.test(censored)) {
      hasViolation = true;
      censored = censored.replace(pattern, "***");
    }
    pattern.lastIndex = 0;
  });
  return { censored, hasViolation };
}

function detectAgreement(text) {
  const agreementWords = [
    "d'accord", "ok", "oui", "accepte", "accepté", "convenu",
    "parfait", "marché conclu", "on est ok", "c'est bon", "accord",
    "je suis ok", "je suis d'accord", "allons-y", "c'est parti",
  ];
  const lower = text.toLowerCase();
  return agreementWords.some((w) => lower.includes(w));
}

// ================================
// CRÉER OU RÉCUPÉRER SESSION CHAT
// ================================
router.post("/session/:offerId", auth, async (req, res) => {
  try {
    const offer = await Offer.findById(req.params.offerId)
      .populate("family", "firstName lastName phone city")
      .populate("applications.provider", "firstName lastName phone city serviceType pricingAmount");

    if (!offer) return res.status(404).json({ message: "Offre introuvable" });

    // Trouver le prestataire accepté
    const acceptedApp = offer.applications.find(a => a.status === "accepted");
    if (!acceptedApp) return res.status(400).json({ message: "Aucune candidature acceptée" });

    const familyId = offer.family._id;
    const providerId = acceptedApp.provider._id;

    // Vérifier que l'utilisateur est bien partie prenante
    const userId = req.user.id;
    if (userId !== familyId.toString() && userId !== providerId.toString()) {
      return res.status(403).json({ message: "Non autorisé" });
    }

    // Créer ou récupérer la session
    let session = await ChatSession.findOne({ offerId: offer._id });
    if (!session) {
      session = await ChatSession.create({
        offerId: offer._id,
        familyId,
        providerId,
        invoiceAmount: computeInvoiceAmount(acceptedApp.provider.pricingAmount),
      });

      // Message de bienvenue du système
      const welcomeMsg = `🤝 Bonjour ! Je suis l'assistant ISD.

Une collaboration a été établie entre vous. Vous pouvez maintenant discuter des modalités de votre collaboration.

📋 Rappel des règles :
• Le partage de numéros de téléphone, emails ou réseaux sociaux est strictement interdit
• Une fois votre accord confirmé, une facture vous sera envoyée
• Les coordonnées seront partagées après paiement

Bonne discussion ! 😊`;

      await ChatMessage.create({
        offerId: offer._id,
        familyId,
        providerId,
        senderRole: "system",
        message: welcomeMsg,
        type: "system",
      });
    }

    const messages = await ChatMessage.find({ offerId: offer._id }).sort({ createdAt: 1 });
    return res.json({ session, messages });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ================================
// ENVOYER UN MESSAGE
// ================================
router.post("/message/:offerId", auth, async (req, res) => {
  try {
    const { message, startDate } = req.body;
    if (!message?.trim()) return res.status(400).json({ message: "Message vide" });

    const session = await ChatSession.findOne({ offerId: req.params.offerId });
    if (!session) return res.status(404).json({ message: "Session introuvable" });

    if (session.status === "closed") {
      return res.status(400).json({ message: "Ce chat est fermé" });
    }

    const userId = req.user.id;
    const senderRole = userId === session.familyId.toString() ? "family" : "provider";

    // ================================
    // DÉTECTION INFOS SENSIBLES
    // ================================
    const { censored, hasViolation } = detectAndCensor(message);

    if (hasViolation) {
      session.warningCount += 1;
      await session.save();

      // Sauvegarder message censuré
      const blockedMsg = await ChatMessage.create({
        offerId: req.params.offerId,
        familyId: session.familyId,
        providerId: session.providerId,
        senderRole,
        message: "🔒 [Message masqué - contenu interdit]",
        originalMessage: message,
        isBlocked: true,
        type: "warning",
      });

      // Avertissement système
      const warnIndex = Math.min(session.warningCount - 1, WARNING_MESSAGES.length - 1);
      const warnMsg = await ChatMessage.create({
        offerId: req.params.offerId,
        familyId: session.familyId,
        providerId: session.providerId,
        senderRole: "system",
        message: WARNING_MESSAGES[warnIndex],
        type: "warning",
      });

      // Fermer le chat si 3 avertissements
      if (session.warningCount >= 3) {
        session.status = "closed";
        await session.save();
      }

      const io = req.app.get("io");
      if (io) {
        io.to(`chat_${req.params.offerId}`).emit("new_message", blockedMsg);
        io.to(`chat_${req.params.offerId}`).emit("new_message", warnMsg);
      }

      return res.json({ blocked: true, warning: WARNING_MESSAGES[warnIndex], session });
    }

    // ================================
    // MESSAGE NORMAL
    // ================================
    const savedMsg = await ChatMessage.create({
      offerId: req.params.offerId,
      familyId: session.familyId,
      providerId: session.providerId,
      senderRole,
      message: censored,
      type: "text",
    });

    // ================================
    // DÉTECTION ACCORD
    // ================================
    if (detectAgreement(message)) {
      if (senderRole === "family") session.familyAgreed = true;
      if (senderRole === "provider") session.providerAgreed = true;

      // Sauvegarder date de début si fournie
      if (startDate) session.startDate = new Date(startDate);

      await session.save();

      // Si les DEUX parties sont d'accord → envoyer facture
      if (session.familyAgreed && session.providerAgreed && session.status === "active") {
        session.status = "agreement_reached";
        await session.save();

        // Récupérer le prestataire pour calculer la facture (20% de son tarif, arrondi au multiple de 100)
        const provider = await User.findById(session.providerId);
        const invoiceAmount = computeInvoiceAmount(provider?.pricingAmount);
        session.invoiceAmount = invoiceAmount;
        session.status = "invoice_sent";
        await session.save();

        const invoiceMsg = await ChatMessage.create({
          offerId: req.params.offerId,
          familyId: session.familyId,
          providerId: session.providerId,
          senderRole: "system",
          message: `🎉 Accord confirmé entre les deux parties !

💼 Récapitulatif de la collaboration :
• Service : ${(provider?.serviceType || provider?.role) === "nanny" ? "Garde d'enfants (Nounou)" : "Cours particuliers (Répétiteur)"}
• Prestataire : ${provider?.firstName} ${provider?.lastName}
• Tarif prestataire : ${provider?.pricingAmount || 0} FCFA

💳 Facture ISD Services (commission 20%)
Pour finaliser la mise en relation, veuillez régler la commission ISD :

Montant : ${invoiceAmount} FCFA
Mode de paiement : Mobile Money
Numéro ISD : ${ISD_MOBILE_MONEY_NUMBER}

📲 Une fois le paiement effectué, les coordonnées complètes des deux parties vous seront communiquées automatiquement.

Référence : ISD-${req.params.offerId.toString().slice(-6).toUpperCase()}`,
          type: "invoice",
        });

        // Notifier la famille (c'est elle qui doit payer)
        await Notification.create({
          userId: session.familyId,
          title: "Facture ISD disponible",
          message: `Un accord a été trouvé. Merci de régler ${invoiceAmount} FCFA via Mobile Money (${ISD_MOBILE_MONEY_NUMBER}) pour débloquer les coordonnées.`,
          type: "system_alert",
          metadata: { offerId: req.params.offerId, invoiceAmount },
        });

        const io = req.app.get("io");
        if (io) {
          io.to(`chat_${req.params.offerId}`).emit("new_message", savedMsg);
          io.to(`chat_${req.params.offerId}`).emit("new_message", invoiceMsg);
          io.to(`chat_${req.params.offerId}`).emit("invoice_sent", { invoiceAmount, session });
        }

        return res.json({ message: savedMsg, invoiceSent: true, session });
      }

      // Un seul accord pour l'instant
      const agreeMsg = await ChatMessage.create({
        offerId: req.params.offerId,
        familyId: session.familyId,
        providerId: session.providerId,
        senderRole: "system",
        message: senderRole === "family"
          ? "✅ La famille a confirmé son accord. En attente de la confirmation du prestataire."
          : "✅ Le prestataire a confirmé son accord. En attente de la confirmation de la famille.",
        type: "system",
      });

      const io = req.app.get("io");
      if (io) {
        io.to(`chat_${req.params.offerId}`).emit("new_message", savedMsg);
        io.to(`chat_${req.params.offerId}`).emit("new_message", agreeMsg);
      }

      return res.json({ message: savedMsg, partialAgreement: true });
    }

    // Émettre le message via socket
    const io = req.app.get("io");
    if (io) {
      io.to(`chat_${req.params.offerId}`).emit("new_message", savedMsg);
    }

    return res.json({ message: savedMsg });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ================================
// CONFIRMER PAIEMENT (admin/système)
// Révèle les infos de contact + crée le Booking lié
// ================================
router.post("/confirm-payment/:offerId", auth, async (req, res) => {
  try {
    const session = await ChatSession.findOne({ offerId: req.params.offerId });
    if (!session) return res.status(404).json({ message: "Session introuvable" });

    const family = await User.findById(session.familyId);
    const provider = await User.findById(session.providerId);
    const offer = await Offer.findById(req.params.offerId);

    session.isPaid = true;
    session.status = "paid";
    session.infoRevealed = true;
    await session.save();

    // Créer le Booking correspondant, pour qu'il apparaisse dans
    // "Mes réservations" des deux côtés (famille et prestataire).
    let booking = await Booking.findOne({ offerId: req.params.offerId });
    if (!booking) {
      booking = await Booking.create({
        familyId: session.familyId,
        providerId: session.providerId,
        offerId: req.params.offerId,
        serviceType: offer?.serviceType || provider?.serviceType || provider?.role,
        subject: offer?.subjects?.length ? offer.subjects.join(", ") : undefined,
        description: offer?.description || "Collaboration via offre ISD",
        city: offer?.city || family?.city || provider?.city || "",
        price: provider?.pricingAmount || offer?.price || 0,
        status: "active",
        startDate: session.startDate || null,
        chatEnabled: true,
        isPaid: true,
      });
    }

    const startDateStr = session.startDate
      ? new Date(session.startDate).toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" })
      : "À convenir";

    const revealMsg = await ChatMessage.create({
      offerId: req.params.offerId,
      familyId: session.familyId,
      providerId: session.providerId,
      senderRole: "system",
      message: `✅ Paiement confirmé ! Voici les coordonnées des deux parties :

👨‍👩‍👧 Famille :
• Nom : ${family?.firstName} ${family?.lastName}
• Téléphone : ${family?.phone}
• Commune : ${family?.city}

${(provider?.serviceType || provider?.role) === "nanny" ? "👩‍🍼 Nounou" : "📚 Répétiteur"} :
• Nom : ${provider?.firstName} ${provider?.lastName}
• Téléphone : ${provider?.phone}
• Commune : ${provider?.city}

📅 Date de début de collaboration : ${startDateStr}

🎉 ISD Services vous souhaite une excellente collaboration !
Pour toute assistance, contactez-nous.

ℹ️ Vous pourrez rompre cette collaboration à tout moment depuis votre espace "Mes réservations" si besoin.`,
      type: "info_reveal",
    });

    // Notifier les deux parties que les contacts sont révélés
    await Notification.create({
      userId: session.familyId,
      title: "Coordonnées débloquées",
      message: "Le paiement est confirmé. Les coordonnées du prestataire sont disponibles dans votre chat.",
      type: "system_alert",
      metadata: { offerId: req.params.offerId, bookingId: booking._id },
    });
    await Notification.create({
      userId: session.providerId,
      title: "Coordonnées débloquées",
      message: "Le paiement de la famille est confirmé. Vos coordonnées mutuelles sont disponibles dans votre chat.",
      type: "system_alert",
      metadata: { offerId: req.params.offerId, bookingId: booking._id },
    });

    const io = req.app.get("io");
    if (io) {
      io.to(`chat_${req.params.offerId}`).emit("new_message", revealMsg);
      io.to(`chat_${req.params.offerId}`).emit("payment_confirmed", { family, provider, booking });
    }

    return res.json({ message: "Paiement confirmé, infos révélées", revealMsg, booking });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ================================
// ROMPRE LA COLLABORATION (après accord/paiement)
// Accessible à la famille ou au prestataire
// Synchronise aussi le Booking lié, s'il existe
// ================================
router.post("/end-collaboration/:offerId", auth, async (req, res) => {
  try {
    const session = await ChatSession.findOne({ offerId: req.params.offerId });
    if (!session) return res.status(404).json({ message: "Session introuvable" });

    const userId = req.user.id;
    const isFamily = userId === session.familyId.toString();
    const isProvider = userId === session.providerId.toString();

    if (!isFamily && !isProvider) {
      return res.status(403).json({ message: "Non autorisé" });
    }

    if (session.status === "closed") {
      return res.status(400).json({ message: "Cette collaboration est déjà terminée" });
    }

    session.status = "closed";
    await session.save();

    // Synchroniser le Booking lié, s'il existe
    const booking = await Booking.findOne({ offerId: req.params.offerId });
    if (booking && !["completed", "cancelled"].includes(booking.status)) {
      booking.status = "cancelled";
      await booking.save();
    }

    const initiatorLabel = isFamily ? "la famille" : "le prestataire";
    const otherPartyId = isFamily ? session.providerId : session.familyId;

    const endMsg = await ChatMessage.create({
      offerId: req.params.offerId,
      familyId: session.familyId,
      providerId: session.providerId,
      senderRole: "system",
      message: `🔚 ${initiatorLabel.charAt(0).toUpperCase() + initiatorLabel.slice(1)} a mis fin à cette collaboration. Ce chat est désormais clos.`,
      type: "system",
    });

    await Notification.create({
      userId: otherPartyId,
      title: "Collaboration terminée",
      message: `${initiatorLabel.charAt(0).toUpperCase() + initiatorLabel.slice(1)} a mis fin à votre collaboration.`,
      type: "system_alert",
      metadata: { offerId: req.params.offerId },
    });

    const io = req.app.get("io");
    if (io) {
      io.to(`chat_${req.params.offerId}`).emit("new_message", endMsg);
      io.to(`chat_${req.params.offerId}`).emit("collaboration_ended", { session });
    }

    return res.json({ message: "Collaboration terminée", session });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ================================
// RÉCUPÉRER MESSAGES
// ================================
router.get("/messages/:offerId", auth, async (req, res) => {
  try {
    const messages = await ChatMessage.find({ offerId: req.params.offerId })
      .sort({ createdAt: 1 });
    const session = await ChatSession.findOne({ offerId: req.params.offerId });
    return res.json({ messages, session });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;
