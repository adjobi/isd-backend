const mongoose = require("mongoose");

// Notation mutuelle liée à une réservation/collaboration terminée.
// Chaque partie (famille ou prestataire) peut noter l'autre une seule fois
// par réservation (contrainte d'unicité bookingId + fromUserId).
const bookingReviewSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },
    fromUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    toUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    fromRole: {
      type: String,
      enum: ["family", "provider"],
      required: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    comment: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

// Empêche une même personne de noter deux fois la même réservation
bookingReviewSchema.index({ bookingId: 1, fromUserId: 1 }, { unique: true });

module.exports = mongoose.model("BookingReview", bookingReviewSchema);
