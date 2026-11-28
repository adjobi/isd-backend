// Tentatives de partage de coordonnées : compteur cumulé par compte (chat, candidature, offre, profil).
// Tous les 5 refus, un signalement est créé pour l'équipe ISD (Espace ISD › Signalements).
// Aucune suspension automatique : l'équipe décide.
const User = require("../models/User");
const Report = require("../models/Report");

const STRIKE_ALERT = 5;
const SOURCE_LABELS = {
  chat: "message dans une discussion",
  application: "message de candidature",
  offer: "texte d'une offre",
  profile: "profil",
};

// Compte une tentative ; ne fait jamais échouer l'action en cours. Renvoie le total (ou null).
async function recordContactStrike(userId, source) {
  if (!userId) return null;
  try {
    const user = await User.findByIdAndUpdate(userId, { $inc: { contactStrikes: 1 } }, { new: true })
      .select("+contactStrikes role").lean();
    const n = user?.contactStrikes || 0;
    if (n > 0 && n % STRIKE_ALERT === 0) {
      await Report.create({
        kind: "contact_strikes", against: userId, byRole: "system", reason: "contact_strikes", strikes: n,
        comment: `${n} tentatives de partage de coordonnées refusées (dernière : ${SOURCE_LABELS[source] || source}). À vérifier par l'équipe ISD ; aucune suspension automatique.`,
      });
    }
    return n;
  } catch (err) {
    console.error("compteur de coordonnées", err.message);
    return null;
  }
}

module.exports = { recordContactStrike, STRIKE_ALERT, SOURCE_LABELS };
