// Avis des familles après une mission : quand on peut noter, validation, note moyenne du profil.
const MissionReview = require("../models/MissionReview");
const User = require("../models/User");
const { containsChatContact } = require("../validators/contact");

// Une semaine de mission au moins avant de pouvoir donner un avis (ou mission terminée).
const REVIEW_AFTER_DAYS = 7;
const COMMENT_MAX = 500;
const DAY = 24 * 60 * 60 * 1000;

// Date à partir de laquelle la famille peut noter, ou null si les engagements ne sont pas confirmés.
function reviewOpensAt(contract) {
  const a = contract?.acceptedAt || {};
  if (!a.family || !a.provider) return null;
  const accepted = Math.max(new Date(a.family).getTime(), new Date(a.provider).getTime());
  const start = contract.terms?.startDate ? new Date(contract.terms.startDate).getTime() : accepted;
  const opens = Math.max(accepted, start) + REVIEW_AFTER_DAYS * DAY;
  // Mission terminée plus tôt (fin convenue, préavis écoulé, faute grave) : avis possible dès la fin.
  if (contract.endedAt) return new Date(Math.min(opens, Math.max(accepted, new Date(contract.endedAt).getTime())));
  return new Date(opens);
}

const canReview = (contract, now = new Date()) => {
  const opens = reviewOpensAt(contract);
  return !!opens && opens <= now;
};

// { rating, comment } validés, ou { errors }.
function readReview(body) {
  const errors = {};
  const rating = Number(body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) errors.rating = "Choisissez une note de 1 à 5 étoiles";
  const comment = typeof body?.comment === "string" ? body.comment.trim().replace(/\s+/g, " ") : "";
  if (comment.length > COMMENT_MAX) errors.comment = `${COMMENT_MAX} caractères maximum`;
  else if (containsChatContact(comment)) errors.comment = "Pas de numéro, d'email ni de réseau social dans un avis public";
  return Object.keys(errors).length ? { errors } : { rating, comment };
}

// Recalcule la note moyenne et le nombre d'avis publiés du prestataire.
async function refreshProviderRating(providerId) {
  const [s] = await MissionReview.aggregate([
    { $match: { provider: providerId, status: "published" } },
    { $group: { _id: null, avg: { $avg: "$rating" }, n: { $sum: 1 } } },
  ]);
  const rating = s ? Math.round(s.avg * 10) / 10 : 0;
  await User.updateOne({ _id: providerId }, { $set: { rating, reviewCount: s?.n || 0 } });
  return { rating, reviewCount: s?.n || 0 };
}

const shortName = (u) => (u ? [String(u.firstName || "").trim().split(/\s+/)[0], u.lastName ? `${String(u.lastName).trim()[0].toUpperCase()}.` : ""].filter(Boolean).join(" ") : "");

module.exports = { REVIEW_AFTER_DAYS, COMMENT_MAX, reviewOpensAt, canReview, readReview, refreshProviderRating, shortName };
