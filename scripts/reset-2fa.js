// Désactive la double authentification d'un compte (téléphone perdu ET codes de secours perdus).
// À utiliser seulement après avoir vérifié l'identité de la personne (en face à face ou par appel).
// Usage : npm run reset-2fa -- email@exemple.com
// Base locale par défaut. Sur le serveur en ligne, ajouter --production (choix explicite) :
//   docker compose exec api node scripts/reset-2fa.js email@exemple.com --production
// La personne devra la réactiver (obligatoire pour l'Espace ISD en production).
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");

const uri = process.env.MONGO_URI || "";
const email = (process.argv[2] || "").trim().toLowerCase();
const production = process.argv.includes("--production");

(async () => {
  if (!production && !/^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri)) {
    console.error("Refusé : base distante. Sur le serveur en ligne, ajoutez --production.");
    process.exit(1);
  }
  if (!email.includes("@")) {
    console.error("Usage : npm run reset-2fa -- email@exemple.com");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const user = await User.findOneAndUpdate(
    { email },
    { $set: { twoFactorEnabled: false }, $unset: { twoFactor: 1 } },
    { new: true }
  ).select("email role isAdmin twoFactorEnabled");
  if (!user) console.error(`Aucun compte pour ${email}.`);
  else console.log(`${user.email} : double authentification désactivée. À réactiver depuis l'app (Espace ISD).`);
  await mongoose.disconnect();
  process.exit(user ? 0 : 1);
})();
