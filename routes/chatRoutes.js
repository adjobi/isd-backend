const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { ChatMessage, ChatSession } = require("../models/Chat");
const Offer = require("../models/Offer");
const User = require("../models/User");

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
        invoiceAmount: acceptedApp.provider.pricingAmount || 0,
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

        // Récupérer le prestataire pour calculer la facture
        const provider = await User.findById(session.providerId);
        const invoiceAmount = provider?.pricingAmount || 0;
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
• Service : ${provider?.serviceType === "nanny" ? "Garde d'enfants (Nounou)" : "Cours particuliers (Répétiteur)"}
• Prestataire : ${provider?.firstName} ${provider?.lastName}
• Montant mensuel : ${invoiceAmount} FCFA

💳 Facture ISD Services
Pour finaliser la mise en relation, veuillez régler la commission ISD :

Montant : ${invoiceAmount} FCFA
Mode de paiement : Mobile Money
Numéro ISD : +225 XX XX XX XX XX

📲 Une fois le paiement effectué, les coordonnées complètes des deux parties vous seront communiquées automatiquement.

Référence : ISD-${req.params.offerId.toString().slice(-6).toUpperCase()}`,
          type: "invoice",
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
// Révèle les infos de contact
// ================================
router.post("/confirm-payment/:offerId", auth, async (req, res) => {
  try {
    const session = await ChatSession.findOne({ offerId: req.params.offerId });
    if (!session) return res.status(404).json({ message: "Session introuvable" });

    const family = await User.findById(session.familyId);
    const provider = await User.findById(session.providerId);

    session.isPaid = true;
    session.status = "paid";
    session.infoRevealed = true;
    await session.save();

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

${provider?.serviceType === "nanny" ? "👩‍🍼 Nounou" : "📚 Répétiteur"} :
• Nom : ${provider?.firstName} ${provider?.lastName}
• Téléphone : ${provider?.phone}
• Commune : ${provider?.city}

📅 Date de début de collaboration : ${startDateStr}

🎉 ISD Services vous souhaite une excellente collaboration !
Pour toute assistance, contactez-nous.`,
      type: "info_reveal",
    });

    const io = req.app.get("io");
    if (io) {
      io.to(`chat_${req.params.offerId}`).emit("new_message", revealMsg);
      io.to(`chat_${req.params.offerId}`).emit("payment_confirmed", { family, provider });
    }

    return res.json({ message: "Paiement confirmé, infos révélées", revealMsg });
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
