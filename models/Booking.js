const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    nannyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Nanny",
      required: true,
    },

    date: {
      type: Date,
      required: true,
    },

    durationHours: {
      type: Number,
      default: 1,
    },

    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "completed"],
      default: "pending",
    },

    location: {
      type: String,
      default: "",
    },

    price: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Booking", bookingSchema);
