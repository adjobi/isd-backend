const mongoose = require("mongoose");
const bookingSchema = new mongoose.Schema(
  {
    // ======================
    // PARTIES
    // ======================
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
    // Lien vers l'offre/chat d'origine, si ce booking a été créé
    // automatiquement suite à un accord + paiement dans le système Offer/Chat.
    offerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Offer",
      default: null,
    },
    // ======================
    // SERVICE INFO
    // ======================
    serviceType: {
      type: String,
      enum: ["nanny", "tutor"],
      required: true,
    },
    subject: {
      type: String, // tutor only
    },
    description: {
      type: String,
      default: "",
    },
    city: {
      type: String,
      required: true,
    },
    // ======================
    // PRICING SNAPSHOT (IMPORTANT)
    // ======================
    price: {
      type: Number,
      required: true,
    },
    pricingType: {
      type: String,
      enum: ["hour", "session", "month"],
    },
    // ======================
    // STATUS WORKFLOW
    // ======================
    status: {
      type: String,
      enum: [
        "pending",
        "accepted",
        "rejected",
        "scheduled",
        "active",
        "completed",
        "cancelled",
      ],
      default: "pending",
    },
    // ======================
    // NEGOTIATION
    // ======================
    proposedDate: {
      type: Date,
    },
    startDate: {
      type: Date,
    },
    endDate: {
      type: Date,
    },
    // ======================
    // CHAT / SYSTEM TRIGGER
    // ======================
    chatEnabled: {
      type: Boolean,
      default: false,
    },
    isPaid: {
      type: Boolean,
      default: false,
    },
    // ======================
    // RETRAIT D'HISTORIQUE (propre à chaque profil)
    // Permet à la famille ou au prestataire de "supprimer" une réservation
    // terminée/annulée de SA propre liste, sans affecter l'autre partie
    // ni casser le lien avec les notations.
    // ======================
    familyHidden: {
      type: Boolean,
      default: false,
    },
    providerHidden: {
      type: Boolean,
      default: false,
    },
    // ======================
    // NOTATION MUTUELLE
    // Indique si chaque partie a déjà soumis sa note pour cette collaboration
    // (le détail note/commentaire est stocké dans BookingReview).
    // ======================
    familyReviewed: {
      type: Boolean,
      default: false,
    },
    providerReviewed: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);
module.exports = mongoose.model("Booking", bookingSchema);
