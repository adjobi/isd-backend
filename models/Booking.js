const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    // ======================
    // PARTIES
    // ======================
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    providerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // ======================
    // SERVICE INFO
    // ======================
    serviceType: {
      type: String,
      enum: ["nanny", "tutor"],
      required: true,
    },

    subject: {
      type: String, // tutor only
    },

    description: {
      type: String,
      default: "",
    },

    city: {
      type: String,
      required: true,
    },

    // ======================
    // PRICING SNAPSHOT (IMPORTANT)
    // ======================
    price: {
      type: Number,
      required: true,
    },

    pricingType: {
      type: String,
      enum: ["hour", "session", "month"],
    },

    // ======================
    // STATUS WORKFLOW
    // ======================
    status: {
      type: String,
      enum: [
        "pending",
        "accepted",
        "rejected",
        "scheduled",
        "active",
        "completed",
        "cancelled",
      ],
      default: "pending",
    },

    // ======================
    // NEGOTIATION
    // ======================
    proposedDate: {
      type: Date,
    },

    startDate: {
      type: Date,
    },

    endDate: {
      type: Date,
    },

    // ======================
    // CHAT / SYSTEM TRIGGER
    // ======================
    chatEnabled: {
      type: Boolean,
      default: false,
    },

    isPaid: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Booking", bookingSchema);
