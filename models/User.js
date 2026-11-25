const mongoose = require("mongoose");
const userSchema = new mongoose.Schema(
  {
    // ======================
    // AUTH
    // ======================
    role: { type: String, enum: ["family", "nanny", "tutor"], required: true },
    email: { type: String, unique: true, required: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    // Droits d'administration ISD (validation des paiements, tarifs).
    // Jamais modifiable depuis l'app : uniquement par scripts/make-admin.js.
    isAdmin: { type: Boolean, default: false },
    // Double authentification (code de l'application d'authentification), obligatoire pour l'Espace ISD.
    twoFactorEnabled: { type: Boolean, default: false },
    // Secrets : jamais renvoyés par les requêtes (select: false), clé chiffrée (AES-256-GCM).
    twoFactor: {
      type: new mongoose.Schema({
        secret: String,          // clé active, chiffrée
        pendingSecret: String,   // clé en cours d'activation, chiffrée
        lastStep: { type: Number, default: -1 }, // dernier code utilisé (pas de rejeu)
        recoveryCodes: { type: [String], default: [] }, // codes de secours, hachés (SHA-256)
        enabledAt: Date,
      }, { _id: false }),
      default: undefined,
      select: false,
    },

    // ======================
    // PROFILE COMMON
    // ======================
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    phone: { type: String, required: true },
    city: { type: String, required: true },           // ville
    commune: { type: String, default: "" },             // ✅ commune d'habitation
    photo: { type: String, default: "" },                // ✅ photo de profil (base64 ou URL)
    photoUpdatedAt: { type: Date, default: null },       // version de la photo (adresse publique)
    photoPublic: { type: Boolean, default: false },      // prestataire : accepte que sa photo soit visible sur le site public
    bio: { type: String, default: "" },                  // description du profil
    values: { type: [String], default: [] },             // ✅ valeurs (ex: ponctualité, bienveillance)
    skills: { type: [String], default: [] },              // ✅ compétences (premiers secours, cuisine, etc.)

    // ======================
    // PROVIDER DATA (NANNY / TUTOR)
    // ======================
    serviceType: { type: String, enum: ["nanny", "tutor"] },
    subjects: { type: [String], default: [] },
    pricingType: { type: String, enum: ["hour", "day", "session", "month"] },
    pricingAmount: { type: Number },

    // ======================
    // MARKETPLACE STATUS
    // ======================
    availability: { type: String, enum: ["available", "busy", "away", "holiday"], default: "available" },
    rating: { type: Number, default: 0 },               // moyenne des avis publiés des familles
    reviewCount: { type: Number, default: 0 },
    isVerified: { type: Boolean, default: false },
    isProfileCompleted: { type: Boolean, default: false },
    lastLogin: { type: Date, default: null },
  },
  { timestamps: true }
);
module.exports = mongoose.model("User", userSchema);
