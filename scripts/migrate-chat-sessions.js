// Discussions : une par (offre, prestataire) au lieu d'une par offre.
// Retire l'ancien index unique { offerId: 1 } de chatsessions et crée { offerId: 1, providerId: 1 } (unique).
// Aucune donnée n'est modifiée ni supprimée : seuls les index changent.
// Usage : npm run migrate-chat-sessions              (aperçu, base locale)
//         npm run migrate-chat-sessions -- --apply   (applique)
// Sur le serveur en ligne, ajouter --production (choix explicite).
require("dotenv").config();
const mongoose = require("mongoose");
const { ChatSession } = require("../models/Chat");
const { legacyIndex } = require("../services/chatIndexes");

const uri = process.env.MONGO_URI || "";
const apply = process.argv.includes("--apply");
const production = process.argv.includes("--production");

(async () => {
  if (!production && !/^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri)) {
    console.error("Refusé : base distante. Sur le serveur en ligne, ajoutez --production.");
    process.exit(1);
  }
  try {
    await mongoose.connect(uri);
    const idx = await legacyIndex();
    const sessions = await ChatSession.countDocuments();
    console.log(`${sessions} discussion(s). Ancien index unique : ${idx ? idx.name : "absent"}.`);
    if (!apply) {
      console.log("Aperçu seulement. Relancez avec --apply pour appliquer.");
    } else {
      // D'abord le nouvel index (jamais de fenêtre sans contrainte d'unicité), puis le retrait de l'ancien.
      await ChatSession.createIndexes();
      console.log("Index { offerId: 1, providerId: 1 } (unique) en place.");
      if (idx) {
        await ChatSession.collection.dropIndex(idx.name);
        console.log(`Index ${idx.name} retiré.`);
      }
    }
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("Migration impossible :", err.message);
    process.exit(1);
  }
})();
