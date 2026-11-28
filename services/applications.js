// Étapes d'une candidature (couple offre × prestataire) et règles de la négociation du salaire.
// Fonctions pures : partagées par les routes des offres, du chat et des actions « À faire ».
//
//   applied ──Discuter──▶ discussion ──accord mission des deux──▶ salary ──prix accepté──▶ accepted
//      │                      │                                     │
//      └──────────── rejected (famille) / withdrawn (prestataire) ◀─┘
const { MAX_COUNTERS } = require("../validators/offer");

const STAGES = ["applied", "discussion", "salary", "accepted", "rejected", "withdrawn"];
const OPEN_STAGES = ["applied", "discussion", "salary"]; // candidature encore en cours
const ACTIVE_STAGES = ["discussion", "salary"]; // discussion ouverte (comptent dans la limite)
const MAX_ACTIVE_DISCUSSIONS = 3; // par offre
const MAX_FAMILY_DISCUSSIONS = 6; // par famille, toutes offres ouvertes confondues
const MISSION_TOGGLE_MIN_MS = 30 * 1000; // entre deux changements d'accord d'une même partie
const MAX_MISSION_TOGGLES = 6; // changements d'accord par candidature (les deux parties)

const idOf = (v) => (v && v._id ? v._id : v)?.toString();
const toPlain = (v) => (v && typeof v.toObject === "function" ? v.toObject() : { ...v });

// Étape d'une candidature. Les candidatures créées avant les étapes n'ont que `status` :
// un statut final l'emporte toujours (et une candidature acceptée n'est jamais « applied »).
function stageOf(app) {
  if (!app) return null;
  if (app.status === "accepted") return "accepted";
  if (app.status === "withdrawn") return "withdrawn";
  if (app.status === "rejected") return app.stage === "withdrawn" ? "withdrawn" : "rejected";
  return STAGES.includes(app.stage) && OPEN_STAGES.includes(app.stage) ? app.stage : "applied";
}
const isOpen = (app) => OPEN_STAGES.includes(stageOf(app));
const isActive = (app) => ACTIVE_STAGES.includes(stageOf(app));
const activeCount = (offer) => (offer?.applications || []).filter(isActive).length;

// Négociation du salaire : la première proposition (de l'un ou l'autre) ne compte pas
// comme contre-proposition ; ensuite chacun son tour, MAX_COUNTERS chacun.
const historyOf = (app) => (Array.isArray(app?.history) ? app.history : []);
const lastBy = (app) => {
  const h = historyOf(app);
  return h.length ? h[h.length - 1].by : null;
};
function countersUsed(app, by) {
  return historyOf(app).filter((h, i) => i > 0 && h.by === by).length;
}
const countersLeft = (app) => ({
  family: Math.max(0, MAX_COUNTERS - countersUsed(app, "family")),
  provider: Math.max(0, MAX_COUNTERS - countersUsed(app, "provider")),
});
// À qui de jouer : null hors étape salaire, "either" tant que personne n'a proposé de prix.
function turnOf(app) {
  if (stageOf(app) !== "salary") return null;
  const last = lastBy(app);
  if (!last) return "either";
  return last === "family" ? "provider" : "family";
}
const otherRole = (role) => (role === "family" ? "provider" : "family");

// Termine une candidature (refus, retrait, autre prestataire choisi, offre fermée, chat fermé par ISD).
function closeApplication(app, stage, reason) {
  app.stage = stage;
  app.status = stage === "withdrawn" ? "withdrawn" : "rejected";
  app.closedAt = new Date();
  app.closedReason = reason;
}

// Candidature telle qu'envoyée à la famille propriétaire ou au prestataire concerné
// (jamais à un autre prestataire).
function serializeApplication(app) {
  const a = toPlain(app);
  const stage = stageOf(a);
  const mission = a.missionAgreed || {};
  return {
    _id: a._id,
    provider: a.provider,
    status: a.status,
    stage,
    message: a.message || "",
    appliedAt: a.appliedAt || null,
    discussionAt: a.discussionAt || null,
    closedAt: a.closedAt || null,
    closedReason: a.closedReason || null,
    sessionId: a.sessionId || null,
    missionAgreed: { family: mission.family || null, provider: mission.provider || null },
    proposedPrice: historyOf(a).length ? a.proposedPrice ?? null : null,
    lastOfferBy: lastBy(a),
    history: historyOf(a).map((h) => ({ by: h.by, amount: h.amount, unit: h.unit || "month", at: h.at })),
    countersLeft: countersLeft(a),
    turn: turnOf(a),
  };
}

module.exports = {
  STAGES, OPEN_STAGES, ACTIVE_STAGES, MAX_ACTIVE_DISCUSSIONS, MAX_FAMILY_DISCUSSIONS, MISSION_TOGGLE_MIN_MS, MAX_MISSION_TOGGLES, MAX_COUNTERS,
  idOf, stageOf, isOpen, isActive, activeCount, lastBy, countersUsed, countersLeft, turnOf, otherRole, closeApplication,
  serializeApplication,
};
