const mongoose = require("mongoose");

// Avis d'une famille sur la nounou ou le répétiteur, après une mission réelle (engagements
// confirmés). Un avis par mission ; publié sur le profil et le site, masquable par l'équipe ISD.
const missionReviewSchema = new mongoose.Schema(
  {
    contractId: { type: mongoose.Schema.Types.ObjectId, ref: "Contract", required: true, unique: true },
    offerId: { type: mongoose.Schema.Types.ObjectId, ref: "Offer", required: true },
    family: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    provider: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    serviceType: { type: String, enum: ["nanny", "tutor"], required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: "", maxlength: 500 },
    status: { type: String, enum: ["published", "hidden"], default: "published", index: true },
    moderation: {
      type: new mongoose.Schema({
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        at: Date,
        note: String,
      }, { _id: false }),
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MissionReview", missionReviewSchema);
