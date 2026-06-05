const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    // ================= IDENTITÉ =================
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },

    role: {
      type: String,
      enum: ["family", "nanny", "teacher"],
      required: true
    },

    phone: String,
    city: String,

    // ================= PROFIL COMMUN =================
    bio: String,
    profileImage: String,

    // ================= NANNY =================
    nannyProfile: {
      experienceYears: Number,
      childAgeMin: Number,
      childAgeMax: Number,
      services: [String], // ex: ["baby-sitting", "nuit", "weekend"]
      hourlyRate: Number
    },

    // ================= TEACHER =================
    teacherProfile: {
      subjects: [String], // maths, anglais...
      levels: [String],   // primaire, collège, lycée
      hourlyRate: Number,
      experienceYears: Number
    },

    // ================= DISPONIBILITÉ =================
    availability: {
      monday: Boolean,
      tuesday: Boolean,
      wednesday: Boolean,
      thursday: Boolean,
      friday: Boolean,
      saturday: Boolean,
      sunday: Boolean
    },

    // ================= LOCALISATION =================
    location: {
      address: String,
      city: String,
      lat: Number,
      lng: Number
    },

    // ================= STATS =================
    rating: {
      type: Number,
      default: 0
    },
    reviewsCount: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
