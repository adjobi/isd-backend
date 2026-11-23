// Donne (ou retire avec --remove) les droits d'administration ISD à un compte existant.
// Usage : npm run make-admin -- email@exemple.com [--remove]
// Base locale par défaut. Sur le serveur en ligne, ajouter --production (choix explicite) :
//   docker compose exec api node scripts/make-admin.js email@exemple.com --production
// Ne crée ni ne supprime aucun compte.
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");

const uri = process.env.MONGO_URI || "";
const email = (process.argv[2] || "").trim().toLowerCase();
const remove = process.argv.includes("--remove");
const production = process.argv.includes("--production");

(async () => {
  if (!production && !/^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri)) {
    console.error("Refusé : base distante. Sur le serveur en ligne, ajoutez --production.");
    process.exit(1);
  }
  if (!email.includes("@")) {
    console.error("Usage : npm run make-admin -- email@exemple.com [--remove]");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const user = await User.findOneAndUpdate({ email }, { $set: { isAdmin: !remove } }, { new: true }).select("email role isAdmin");
  if (!user) console.error(`Aucun compte pour ${email}.`);
  else console.log(`${user.email} (${user.role}) : administrateur ISD = ${user.isAdmin}`);
  await mongoose.disconnect();
  process.exit(user ? 0 : 1);
})();
