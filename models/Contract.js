const mongoose = require("mongoose");

// Contrat ISD : récapitulatif de la mission, accepté par chaque partie dans l'app.
const contractSchema = new mongoose.Schema(
  {
    offerId: { type: mongoose.Schema.Types.ObjectId, ref: "Offer", required: true, unique: true },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true },
    family: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    provider: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    terms: { type: mongoose.Schema.Types.Mixed, required: true },
    acceptedAt: {
      family: { type: Date, default: null },
      provider: { type: Date, default: null },
    },
    endedAt: { type: Date, default: null },
    endReason: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Contract", contractSchema);
