const mongoose = require("mongoose");

const nannySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    bio: {
      type: String,
      default: "",
    },

    services: {
      type: [String], // ex: ["childcare", "cleaning", "tutoring"]
      default: [],
    },

    hourlyRate: {
      type: Number,
      default: 0,
    },

    city: {
      type: String,
      default: "",
    },

    availability: {
      type: [String], // ex: ["monday", "tuesday"]
      default: [],
    },

    experienceYears: {
      type: Number,
      default: 0,
    },

    rating: {
      type: Number,
      default: 0,
    },

    reviewsCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Nanny", nannySchema);
