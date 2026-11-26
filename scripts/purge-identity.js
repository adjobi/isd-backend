// Rétention des vérifications d'identité (même traitement que le serveur, chaque jour) :
// demandes en attente de plus de 30 jours rejetées (utilisateur prévenu), photos supprimées des
// demandes décidées ou dont le compte n'existe plus, demandes à l'ancien format de chiffrement rejetées.
// À lancer après toute restauration de sauvegarde (deploy/restore.sh le fait).
// Usage : npm run purge-identity            (base locale)
// Sur le serveur en ligne, ajouter --production (choix explicite) :
//   docker compose exec -T api node scripts/purge-identity.js --production
require("dotenv").config();
const mongoose = require("mongoose");
const { expireStaleChecks } = require("../services/identity");

const uri = process.env.MONGO_URI || "";
const production = process.argv.includes("--production");

(async () => {
  if (!production && !/^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri)) {
    console.error("Refusé : base distante. Sur le serveur en ligne, ajoutez --production.");
    process.exit(1);
  }
  try {
    await mongoose.connect(uri);
    const r = await expireStaleChecks();
    console.log(`Vérifications d'identité : ${r.expired} expirée(s), ${r.legacy} à l'ancien format, `
      + `${r.purged} photo(s) résiduelle(s) supprimée(s), ${r.orphans} sans compte.`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("Purge impossible :", err.message);
    process.exit(1);
  }
})();
