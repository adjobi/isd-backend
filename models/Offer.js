const mongoose = require("mongoose");

const offerSchema = new mongoose.Schema(
  {
    // Famille qui publie l'offre
    family: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Si renseigné : offre privée/directe visible uniquement par ce prestataire.
    // Si absent : offre publique, visible par tous les prestataires du bon serviceType.
    targetProvider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Type de service recherché
    serviceType: {
      type: String,
      enum: ["nanny", "tutor"],
      required: true,
    },
    // Infos de l'offre
    description: {
      type: String,
      required: true,
    },
    duration: {
      type: String,
      enum: ["short", "long"],
      required: true,
    },
    price: {
      type: Number,
      default: 0,
    },
    // Tutor only
    subjects: {
      type: [String],
      default: [],
    },
    city: {
      type: String,
      required: true,
    },
    // Statut de l'offre
    status: {
      type: String,
      enum: ["open", "closed"],
      default: "open",
    },
    // Accord conclu (candidature acceptée) : base de la facture ISD (Phase 5)
    acceptedProvider: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    agreedPrice: { type: Number, default: null },
    // Unité du salaire convenu (figée à l'accord : base de la facture ISD)
    agreedUnit: { type: String, enum: ["hour", "day", "session", "month", null], default: null },
    acceptedAt: { type: Date, default: null },
    // Facture ISD réglée (Phase 5)
    paidAt: { type: Date, default: null },
    // Offre republiée au titre de la garantie de remplacement : mise en relation gratuite
    replacementOf: { type: mongoose.Schema.Types.ObjectId, ref: "Offer", default: null },
    feeWaived: { type: Boolean, default: false },
    // Candidatures reçues : étapes (services/applications.js), accord sur la mission,
    // puis négociation du salaire dans la discussion privée famille × prestataire.
    applications: [
      {
        provider: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        // Statut historique (toujours tenu à jour) : pending tant que la candidature est en cours.
        status: {
          type: String,
          enum: ["pending", "accepted", "rejected", "withdrawn"],
          default: "pending",
        },
        // Étape : applied → discussion → salary → accepted | rejected | withdrawn
        stage: {
          type: String,
          enum: ["applied", "discussion", "salary", "accepted", "rejected", "withdrawn"],
          default: "applied",
        },
        // Discussion privée (ChatSession) ouverte par « Discuter »
        sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "ChatSession", default: null },
        discussionAt: { type: Date, default: null },
        // « Je suis d'accord sur la mission » : date de confirmation de chaque partie
        missionAgreed: {
          family: { type: Date, default: null },
          provider: { type: Date, default: null },
        },
        // Anti-abus : nombre de changements d'accord et dernier changement de chaque partie
        missionToggles: { type: Number, default: 0 },
        missionLastToggle: {
          family: { type: Date, default: null },
          provider: { type: Date, default: null },
        },
        // Salaire actuellement sur la table et auteur de cette proposition :
        // c'est à l'autre partie de répondre (accepter, contre-proposer ou refuser).
        proposedPrice: { type: Number, default: null },
        lastOfferBy: { type: String, enum: ["family", "provider", null], default: null },
        history: [
          {
            _id: false,
            by: { type: String, enum: ["family", "provider"], required: true },
            amount: { type: Number, required: true },
            unit: { type: String, enum: ["hour", "day", "session", "month"], default: "month" },
            at: { type: Date, default: Date.now },
          },
        ],
        // Carte « proposition de prix » en cours dans le chat (mise à jour à la réponse)
        priceCardId: { type: mongoose.Schema.Types.ObjectId, default: null },
        message: { type: String, default: "" },
        appliedAt: {
          type: Date,
          default: Date.now,
        },
        closedAt: { type: Date, default: null },
        closedReason: { type: String, default: null },
      },
    ],
  },
  { timestamps: true, optimisticConcurrency: true }
);

module.exports = mongoose.model("Offer", offerSchema);
