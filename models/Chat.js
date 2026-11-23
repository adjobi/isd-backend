const mongoose = require("mongoose");

const chatMessageSchema = new mongoose.Schema(
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
      enum: ["text", "system", "warning", "invoice", "info_reveal", "blocked", "start_date"],
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

// ================================
// CHAT SESSION (état de la session)
// ================================
const chatSessionSchema = new mongoose.Schema(
  {
    offerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Offer",
      required: true,
      unique: true,
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
      enum: ["active", "agreement_reached", "invoice_sent", "paid", "closed"],
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

module.exports = {
  ChatMessage: mongoose.model("ChatMessage", chatMessageSchema),
  ChatSession: mongoose.model("ChatSession", chatSessionSchema),
};
