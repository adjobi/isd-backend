const mongoose = require("mongoose");

// Signalement à l'équipe ISD :
//   mission : faute grave lors d'une fin de mission immédiate (par une partie) ;
//   contact_strikes : tentatives répétées de partage de coordonnées (signal automatique, sans suspension).
const isMission = function isMission() { return (this.kind || "mission") === "mission"; };
const reportSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["mission", "contact_strikes"], default: "mission" },
    offerId: { type: mongoose.Schema.Types.ObjectId, ref: "Offer", required: isMission },
    contractId: { type: mongoose.Schema.Types.ObjectId, ref: "Contract", required: isMission },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: isMission },
    byRole: { type: String, enum: ["family", "provider", "system"], required: true },
    strikes: { type: Number, default: null },
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
