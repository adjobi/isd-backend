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
    // Message original avant censure (si contenu sensible)
    originalMessage: {
      type: String,
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
      enum: ["text", "system", "warning", "invoice", "info_reveal"],
      default: "text",
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

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
    // Avertissements
    warningCount: { type: Number, default: 0 },
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
