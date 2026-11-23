const mongoose = require("mongoose");

// Signalement d'une faute grave à l'équipe ISD, lors d'une fin de mission immédiate.
const reportSchema = new mongoose.Schema(
  {
    offerId: { type: mongoose.Schema.Types.ObjectId, ref: "Offer", required: true },
    contractId: { type: mongoose.Schema.Types.ObjectId, ref: "Contract", required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    byRole: { type: String, enum: ["family", "provider"], required: true },
    against: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reason: { type: String, required: true },
    comment: { type: String, default: "" },
    status: { type: String, enum: ["open", "handled"], default: "open" },
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    handledAt: { type: Date, default: null },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);
reportSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("Report", reportSchema);
