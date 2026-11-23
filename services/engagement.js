// Récapitulatif des engagements entre la famille et le prestataire.
// ISD n'est pas partie à l'accord : elle retrace ce que les deux parties ont convenu
// (préavis compris) et la façon dont la mission prend fin.
// Fonctions pures (sans base de données), testées directement.

const DAY = 86400000;
const MAX_NOTICE_DAYS = 90;
const MAX_MUTUAL_DELAY_DAYS = 90;
// Engagements confirmés avant le choix du préavis : la règle affichée à l'époque était 7 jours.
const LEGACY_NOTICE_DAYS = 7;

const END_MODES = ["mutual", "notice", "serious"];
const END_REASONS = {
  family: ["need_over", "moving", "schedule", "not_satisfied", "behaviour", "other"],
  provider: ["personal", "payment", "conditions", "schedule", "behaviour", "other"],
};
const REASON_LABELS = {
  need_over: "Le besoin est terminé",
  moving: "Déménagement",
  schedule: "Horaires devenus incompatibles",
  not_satisfied: "La collaboration ne convient pas",
  behaviour: "Problème de comportement",
  personal: "Raisons personnelles",
  payment: "Rémunération non versée ou en retard",
  conditions: "Conditions convenues non respectées",
  other: "Autre raison",
};

// Engagements figés dans le récapitulatif au moment de sa création.
const COMMITMENTS = [
  "La rémunération convenue est versée directement par la famille au prestataire, aux échéances fixées ensemble. ISD n'intervient pas dans ce paiement.",
  "Le prestataire respecte les horaires, les tâches et le lieu convenus ; la famille assure des conditions de travail dignes et sûres.",
  "Chacun peut mettre fin à la mission en respectant le préavis convenu, ou à tout moment d'un commun accord. En cas de faute grave, la fin peut être immédiate.",
  "Pendant la période de garantie, si la collaboration s'arrête, la famille obtient une nouvelle mise en relation sans frais.",
  "ISD met les parties en relation et conserve ce récapitulatif ; elle n'est pas partie à l'accord. En cas de désaccord, ISD peut proposer une médiation.",
];

const otherRole = (role) => (role === "family" ? "provider" : "family");
// Jours calendaires en UTC (heure d'Abidjan), quel que soit le fuseau du serveur.
const startOfDay = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; };
const cleanText = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

function readNoticeDays(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (!Number.isInteger(n) || n < 0 || n > MAX_NOTICE_DAYS) return { error: `Préavis : un nombre de jours entre 0 et ${MAX_NOTICE_DAYS}` };
  return { value: n };
}

const bothAccepted = (c) => !!(c?.acceptedAt?.family && c?.acceptedAt?.provider);

// Préavis applicable : celui convenu, ou la règle historique pour un accord confirmé sans choix explicite.
function noticeDaysOf(c) {
  const n = c?.terms?.noticeDays;
  if (Number.isInteger(n)) return n;
  return bothAccepted(c) ? LEGACY_NOTICE_DAYS : null;
}

// État : pending (à confirmer), active, ending (fin programmée), ended.
function stateOf(c, now = new Date()) {
  if (c?.endedAt) return new Date(c.endedAt) <= now ? "ended" : "ending";
  return bothAccepted(c) ? "active" : "pending";
}

// Confirmation des engagements par une partie, avec le préavis qu'elle retient.
// Proposer une autre durée que celle sur la table annule la confirmation de l'autre partie.
function applyAccept(c, role, rawNotice, now = new Date()) {
  if (c.endedAt) return { error: "Cette mission est terminée.", status: 409 };
  if (bothAccepted(c)) return { error: "Les engagements sont déjà confirmés par les deux parties.", status: 409 };
  if (!c.acceptedAt) c.acceptedAt = {};
  const other = otherRole(role);
  // Durée sur la table : celle choisie, ou la règle historique si l'autre partie a confirmé avant ce choix.
  const current = c.terms?.noticeDays;
  const agreed = Number.isInteger(current) ? current : (c.acceptedAt[other] ? LEGACY_NOTICE_DAYS : null);
  let notice = agreed;
  if (rawNotice !== undefined && rawNotice !== null) {
    const r = readNoticeDays(rawNotice);
    if (r.error) return { error: r.error, status: 400, field: "noticeDays" };
    notice = r.value;
  }
  if (notice === null) return { error: "Choisissez la durée du préavis avant de confirmer.", status: 400, field: "noticeDays" };

  const changed = notice !== agreed;
  if (!changed && c.acceptedAt[role] && Number.isInteger(current)) return { changed: false, proposed: false, active: false, noop: true };
  c.terms = { ...(c.terms || {}), noticeDays: notice, noticeSetBy: changed ? role : c.terms?.noticeSetBy || other };
  if (changed) c.acceptedAt[other] = null;
  c.acceptedAt[role] = now;
  // « proposed » : la durée diffère de celle que l'autre partie avait retenue, elle doit la confirmer
  return { changed, proposed: changed && agreed !== null, active: bothAccepted(c), notice };
}

// Demande de fin de mission. Renvoie la terminaison à enregistrer ou une erreur.
function planEnd(c, role, body = {}, now = new Date()) {
  const state = stateOf(c, now);
  if (state === "ended") return { error: "Cette mission est déjà terminée.", status: 409 };
  if (state === "ending") return { error: `La fin de la mission est déjà programmée.`, status: 409 };
  const pending = c.termination?.status === "proposed" ? c.termination : null;
  if (pending) {
    return pending.by === role
      ? { error: "Votre proposition de fin attend la réponse de l'autre partie.", status: 409 }
      : { error: "L'autre partie vous a proposé une date de fin : répondez d'abord à sa demande.", status: 409 };
  }

  const mode = body.mode;
  if (!END_MODES.includes(mode)) return { error: "Choisissez comment mettre fin à la mission.", status: 400, field: "mode" };
  const reason = body.reason;
  if (!END_REASONS[role].includes(reason)) return { error: "Choisissez un motif.", status: 400, field: "reason" };
  const comment = cleanText(body.comment);
  if (comment.length > 500) return { error: "Précisions : 500 caractères maximum.", status: 400, field: "comment" };
  if ((mode === "serious" || reason === "other") && comment.length < 20) {
    return { error: "Décrivez la situation (20 caractères minimum).", status: 400, field: "comment" };
  }

  const base = { mode, by: role, reason, comment, requestedAt: now, respondedAt: null };
  if (mode === "mutual") {
    const d = body.date ? new Date(body.date) : null;
    if (!d || Number.isNaN(d.getTime())) return { error: "Choisissez la date de fin proposée.", status: 400, field: "date" };
    const day = startOfDay(d);
    const today = startOfDay(now);
    if (day < today) return { error: "La date de fin ne peut pas être passée.", status: 400, field: "date" };
    if (day - today > MAX_MUTUAL_DELAY_DAYS * DAY) return { error: `La date de fin doit être dans les ${MAX_MUTUAL_DELAY_DAYS} prochains jours.`, status: 400, field: "date" };
    return { termination: { ...base, status: "proposed", effectiveAt: day } };
  }
  if (mode === "serious") {
    return { termination: { ...base, status: "immediate", effectiveAt: now }, endNow: true, report: true };
  }
  // Préavis : sans confirmation commune des engagements, aucun préavis n'a été convenu.
  const days = state === "active" ? noticeDaysOf(c) : 0;
  const effectiveAt = days > 0 ? new Date(startOfDay(now).getTime() + days * DAY) : now;
  return { termination: { ...base, status: "notified", effectiveAt, noticeDays: days }, endNow: days === 0 };
}

// Réponse à une proposition de fin d'un commun accord.
function applyEndResponse(c, role, accept, now = new Date()) {
  const t = c.termination;
  if (!t || t.status !== "proposed") return { error: "Aucune proposition de fin en attente.", status: 409 };
  if (t.by === role) return { error: "C'est à l'autre partie de répondre à votre proposition.", status: 403 };
  if (c.endedAt) return { error: "Cette mission est terminée.", status: 409 };
  const t2 = { ...t, respondedAt: now, status: accept ? "accepted" : "declined" };
  if (!accept) return { termination: t2, endedAt: null };
  const effective = new Date(t.effectiveAt) < now ? now : new Date(t.effectiveAt);
  return { termination: { ...t2, effectiveAt: effective }, endedAt: effective };
}

// La famille garde son droit au remplacement si le prestataire est parti pendant la garantie.
function replacementAllowed(invoice, contract, now = new Date()) {
  if (!invoice || invoice.status !== "paid" || invoice.guaranteeUsedAt || !invoice.guaranteeUntil) return false;
  const until = new Date(invoice.guaranteeUntil);
  if (now <= until) return true;
  const t = contract?.termination;
  return !!(t && t.by === "provider" && ["notified", "immediate", "accepted"].includes(t.status) && new Date(t.requestedAt) <= until);
}

module.exports = {
  COMMITMENTS, END_MODES, END_REASONS, REASON_LABELS, LEGACY_NOTICE_DAYS, MAX_NOTICE_DAYS,
  readNoticeDays, bothAccepted, noticeDaysOf, stateOf, applyAccept, planEnd, applyEndResponse, replacementAllowed, otherRole,
};
