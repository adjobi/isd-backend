const mongoose = require("mongoose");

// Journal des actions de l'équipe ISD (qui a fait quoi, quand) : validation ou refus
// d'un paiement, changement des tarifs. Jamais modifié ni supprimé par l'application.
const adminLogSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    action: { type: String, enum: ["payment_confirmed", "payment_rejected", "pricing_updated"], required: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    ip: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
adminLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AdminLog", adminLogSchema);
