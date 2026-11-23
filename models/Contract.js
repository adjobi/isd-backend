const mongoose = require("mongoose");

// Récapitulatif des engagements pris entre la famille et le prestataire, confirmé par chacun
// dans l'app. ISD n'est pas partie à l'accord : elle le conserve et retrace sa fin.
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
    // Date de fin (dans le futur pendant un préavis)
    endedAt: { type: Date, default: null },
    endReason: { type: String, default: null }, // replacement | mutual | notice | serious
    endedBy: { type: String, enum: ["family", "provider", null], default: null },
    // Demande de fin en cours ou aboutie
    termination: {
      type: new mongoose.Schema({
        mode: { type: String, enum: ["mutual", "notice", "serious"], required: true },
        by: { type: String, enum: ["family", "provider"], required: true },
        reason: { type: String, required: true },
        comment: { type: String, default: "" },
        status: { type: String, enum: ["proposed", "accepted", "declined", "notified", "immediate"], required: true },
        requestedAt: { type: Date, required: true },
        respondedAt: { type: Date, default: null },
        effectiveAt: { type: Date, default: null },
        noticeDays: { type: Number, default: null },
      }, { _id: false }),
      default: null,
    },
  },
  { timestamps: true, optimisticConcurrency: true }
);

module.exports = mongoose.model("Contract", contractSchema);
