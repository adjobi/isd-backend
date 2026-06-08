const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    // ======================
    // AUTH
    // ======================
    role: {
      type: String,
      enum: ["family", "nanny", "tutor"],
      required: true,
    },

    email: {
      type: String,
      unique: true,
      required: true,
      lowercase: true,
      trim: true,
    },

    password: {
      type: String,
      required: true,
    },

    // ======================
    // PROFILE COMMON
    // ======================
    firstName: {
      type: String,
      required: true,
      trim: true,
    },

    lastName: {
      type: String,
      required: true,
      trim: true,
    },

    phone: {
      type: String,
      required: true,
    },

    city: {
      type: String,
      required: true,
    },

    photo: {
      type: String,
      default: "",
    },

    bio: {
      type: String,
      default: "",
    },

    // ======================
    // PROVIDER DATA (NANNY / TUTOR)
    // ======================
    serviceType: {
      type: String,
      enum: ["nanny", "tutor"],
    },

    subjects: {
      type: [String],
      default: [],
    },

    pricingType: {
      type: String,
      enum: ["hour", "session", "month"],
    },

    pricingAmount: {
      type: Number,
    },

    // ======================
    // MARKETPLACE STATUS
    // ======================
    availability: {
      type: String,
      enum: ["available", "busy", "away"],
      default: "available",
    },

    rating: {
      type: Number,
      default: 0,
    },

    isVerified: {
      type: Boolean,
      default: false,
    },

    isProfileCompleted: {
      type: Boolean,
      default: false,
    },

    lastLogin: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
