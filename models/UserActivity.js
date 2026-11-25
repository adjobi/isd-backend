const mongoose = require("mongoose");

// Jours où un compte a utilisé l'app (une ligne par compte et par jour), pour la rétention
// et les utilisateurs actifs. Aucune autre donnée : ni écran, ni action, ni contenu.
const userActivitySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  role: { type: String, enum: ["family", "nanny", "tutor"], required: true },
  day: { type: String, required: true }, // AAAA-MM-JJ
  at: { type: Date, required: true },
});
userActivitySchema.index({ user: 1, day: 1 }, { unique: true });
userActivitySchema.index({ day: 1 });

module.exports = mongoose.model("UserActivity", userActivitySchema);
