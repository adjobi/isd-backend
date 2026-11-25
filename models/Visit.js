const mongoose = require("mongoose");

// Mesure d'audience anonyme du site et de l'app : une ligne par page vue.
// Pas de cookie, pas d'adresse IP, pas de compte : `visitor` est une empreinte du jour
// (IP + navigateur + sel aléatoire renouvelé chaque jour, jamais conservé), impossible à
// relier d'un jour à l'autre ni à une personne. Effacé automatiquement après 13 mois.
const visitSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["site", "app"], required: true },
    path: { type: String, default: "/", maxlength: 120 },
    source: { type: String, default: "direct", maxlength: 40 }, // google, facebook, whatsapp… ou utm_source
    device: { type: String, enum: ["mobile", "desktop"], default: "mobile" },
    platform: { type: String, enum: ["web", "android", "ios"], default: "web" },
    visitor: { type: String, required: true },
    day: { type: String, required: true }, // AAAA-MM-JJ (heure d'Abidjan = UTC)
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
visitSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 3600 });
visitSchema.index({ day: 1, kind: 1 });

module.exports = mongoose.model("Visit", visitSchema);
