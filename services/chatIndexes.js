// Index des discussions : passage d'« une discussion par offre » à « une par (offre, prestataire) ».
// L'ancien index unique { offerId: 1 } empêche d'ouvrir une 2e discussion sur une même offre.
// Il n'est JAMAIS retiré automatiquement : voir scripts/migrate-chat-sessions.js (accord du propriétaire).
const { ChatSession } = require("../models/Chat");

async function legacyIndex() {
  try {
    const indexes = await ChatSession.collection.indexes();
    return indexes.find((i) => i.unique && JSON.stringify(i.key) === JSON.stringify({ offerId: 1 })) || null;
  } catch {
    return null; // collection absente : rien à faire
  }
}

async function warnIfLegacy() {
  const idx = await legacyIndex();
  if (idx) {
    console.warn(`⚠️  Discussions : l'ancien index unique « ${idx.name} » est encore présent sur chatsessions. `
      + "Une seule discussion par offre est possible tant qu'il n'est pas retiré : npm run migrate-chat-sessions -- --apply");
  }
  return !!idx;
}

module.exports = { legacyIndex, warnIfLegacy };
