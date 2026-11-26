const mongoose = require("mongoose");

// Demande d'aide envoyée à l'équipe ISD depuis l'app (« Aide et contact »).
// L'équipe répond dans l'Espace ISD ; la réponse arrive dans les notifications de l'utilisateur.
const supportRequestSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["family", "nanny", "tutor"], required: true },
    topic: { type: String, enum: ["payment", "mission", "account", "other"], required: true },
    message: { type: String, required: true, maxlength: 1000 },
    status: { type: String, enum: ["open", "answered"], default: "open" },
    reply: {
      type: new mongoose.Schema({
        text: { type: String, maxlength: 1000 },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        at: Date,
      }, { _id: false }),
      default: null,
    },
  },
  { timestamps: true }
);
// Liste admin par statut (et compteur des demandes ouvertes) ; « mes demandes » et limite horaire par utilisateur.
supportRequestSchema.index({ status: 1, createdAt: -1 });
supportRequestSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("SupportRequest", supportRequestSchema);
