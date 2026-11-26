const mongoose = require("mongoose");

// Vérification d'identité d'un prestataire (photo de la pièce + selfie).
// Les images sont chiffrées (AES-256-GCM, clé dédiée, utils/identityCrypto.js), jamais renvoyées par défaut
// (select: false) et supprimées dès la décision : on ne garde que le type de pièce,
// le statut, les dates, l'auteur de la décision et le motif de refus. Rétention : 30 jours au plus
// en attente (services/identity.js, expireStaleChecks).
const identityCheckSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Nom du profil au moment de l'envoi : la validation n'est appliquée que s'il n'a pas changé.
    firstName: { type: String, default: "" },
    lastName: { type: String, default: "" },
    docType: { type: String, enum: ["cni", "passport", "attestation", "permis"], required: true },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    submittedAt: { type: Date, default: Date.now },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    rejectReason: { type: String, default: "" },
    // Images chiffrées (data URL), supprimées ($unset) à la décision.
    document: { type: String, select: false },
    selfie: { type: String, select: false },
    // Témoin de présence des images, lisible sans les charger.
    hasImages: { type: Boolean, default: true },
  },
  { timestamps: false }
);
identityCheckSchema.index({ user: 1, submittedAt: -1 });
identityCheckSchema.index({ status: 1, submittedAt: 1 });
// Une seule demande en attente par compte, même en cas d'envois simultanés.
identityCheckSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { status: "pending" } });

module.exports = mongoose.model("IdentityCheck", identityCheckSchema);
