const mongoose = require("mongoose");

const offerSchema = new mongoose.Schema(
  {
    // Famille qui publie l'offre
    family: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
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
    // Candidatures reçues
    applications: [
      {
        provider: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        status: {
          type: String,
          enum: ["pending", "accepted", "rejected"],
          default: "pending",
        },
        appliedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Offer", offerSchema);
