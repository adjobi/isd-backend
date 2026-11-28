const mongoose = require("mongoose");

const chatMessageSchema = new mongoose.Schema(
  {
    // Discussion (ChatSession) du message. Absent sur les anciens messages : la discussion
    // se retrouve alors par (offerId, providerId), toujours renseignés.
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChatSession",
      default: null,
    },
    offerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Offer",
      required: true,
    },
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    providerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Qui a envoyé : "family" | "provider" | "system"
    senderRole: {
      type: String,
      enum: ["family", "provider", "system"],
      required: true,
    },
    // Message affiché
    message: {
      type: String,
      required: true,
    },
    // ANCIEN champ (message original en clair) : n'est plus écrit ni jamais renvoyé.
    originalMessage: {
      type: String,
      default: null,
      select: false,
    },
    // Message original bloqué, chiffré (AES-256-GCM) : jamais renvoyé aux participants.
    originalEncrypted: {
      type: String,
      default: null,
      select: false,
    },
    // Message visible d'une seule partie (avertissement personnel) ; null = les deux.
    visibleTo: {
      type: String,
      enum: ["family", "provider", null],
      default: null,
    },
    // Données d'une carte (ex. proposition de date de début)
    meta: {
      type: Object,
      default: null,
    },
    // Message bloqué ?
    isBlocked: {
      type: Boolean,
      default: false,
    },
    // Type de message
    type: {
      type: String,
      // Cartes : start_date (date de début), mission_agreed (mission validée des deux côtés),
      // price_offer (proposition de salaire), price_accepted (accord conclu), discussion_closed.
      // Le champ `message` reste toujours lisible tel quel.
      enum: ["text", "system", "warning", "invoice", "info_reveal", "blocked", "start_date",
        "mission_agreed", "price_offer", "price_accepted", "discussion_closed"],
      default: "text",
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);
chatMessageSchema.index({ offerId: 1, createdAt: 1 });
chatMessageSchema.index({ offerId: 1, providerId: 1, createdAt: 1 });

// ================================
// CHAT SESSION : une discussion privée par couple (offre, prestataire)
// ================================
const chatSessionSchema = new mongoose.Schema(
  {
    offerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Offer",
      required: true,
    },
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    providerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      // discussion : avant l'accord (mission puis salaire) ; active : accord conclu ;
      // agreement_reached : date de début convenue ; paid : facture ISD réglée ; closed : fermée.
      enum: ["discussion", "active", "agreement_reached", "invoice_sent", "paid", "closed"],
      default: "active",
    },
    // Accord des deux parties
    familyAgreed: { type: Boolean, default: false },
    providerAgreed: { type: Boolean, default: false },
    // Avertissements (total et par partie) ; 3 pour une même partie = chat fermé
    warningCount: { type: Number, default: 0 },
    warnings: {
      family: { type: Number, default: 0 },
      provider: { type: Number, default: 0 },
    },
    closedReason: { type: String, default: null },
    closedBy: { type: String, enum: ["family", "provider", "system", null], default: null },
    lastMessageAt: { type: Date, default: null },
    // Proposition de date de début en attente de confirmation par l'autre partie
    startDateProposal: {
      date: { type: Date, default: null },
      by: { type: String, enum: ["family", "provider", null], default: null },
      at: { type: Date, default: null },
      messageId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    // Dernière lecture de chaque partie (messages non lus, accusés de lecture)
    lastReadAt: {
      family: { type: Date, default: null },
      provider: { type: Date, default: null },
    },
    // Mémoire courte des chiffres envoyés par chaque partie (numéro dicté en plusieurs messages).
    // Jamais renvoyée aux participants.
    contactMemory: { type: Object, default: () => ({ family: [], provider: [] }) },
    // Rappel « coordonnées après paiement » déjà affiché (intention sans coordonnée, non compté)
    contactReminded: {
      family: { type: Boolean, default: false },
      provider: { type: Boolean, default: false },
    },
    // Infos révélées après paiement
    infoRevealed: { type: Boolean, default: false },
    // Date de collaboration convenue
    startDate: { type: Date, default: null },
    // Montant facture ISD
    invoiceAmount: { type: Number, default: 0 },
    isPaid: { type: Boolean, default: false },
  },
  { timestamps: true }
);
// Une seule discussion par couple (offre, prestataire).
// Base existante : l'ancien index unique { offerId: 1 } doit être retiré (scripts/migrate-chat-sessions.js).
chatSessionSchema.index({ offerId: 1, providerId: 1 }, { unique: true });
chatSessionSchema.index({ familyId: 1, lastMessageAt: -1 });
chatSessionSchema.index({ providerId: 1, lastMessageAt: -1 });

module.exports = {
  ChatMessage: mongoose.model("ChatMessage", chatMessageSchema),
  ChatSession: mongoose.model("ChatSession", chatSessionSchema),
};
