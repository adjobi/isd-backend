// Logique partagée du chat à trois (famille, prestataire, système ISD).
const { ChatMessage, ChatSession } = require("../models/Chat");
const Notification = require("../models/Notification");

const ROLES = ["family", "provider"];
const otherRole = (role) => (role === "family" ? "provider" : "family");
// Salons socket : un par discussion (ChatSession) et par rôle.
const room = (sessionId, role) => `chat:${sessionId}:${role}`;
const idOf = (v) => (v && v._id ? v._id : v)?.toString();

const SECURITY = "Pour votre sécurité, téléphone, email, liens et réseaux sociaux sont interdits ici : ils sont échangés automatiquement après le paiement de la facture ISD.";

// Chat ouvert directement à l'accord (anciennes offres, sans étape de discussion).
const WELCOME = [
  "Bienvenue dans votre chat ISD 👋",
  "Prenez le temps de vous présenter, de préciser les horaires, les tâches et le lieu, puis convenez d'une date de début avec le bouton « Date » en haut de l'écran.",
  SECURITY,
].join("\n\n");

// Discussion ouverte par « Discuter » (ou par une proposition directe).
const WELCOME_DISCUSSION = [
  "Bienvenue dans votre discussion ISD 👋",
  "Parlez d'abord de la mission : les tâches, les horaires, les enfants, l'expérience, les matières. Quand la mission vous convient, appuyez chacun sur « Je suis d'accord sur la mission » : vous pourrez alors convenir du salaire.",
  SECURITY,
].join("\n\n");

const UNIT_LABELS = { hour: "de l'heure", day: "par jour", session: "par séance", month: "par mois" };
const formatFCFA = (n) => `${Number(n).toLocaleString("fr-FR")} FCFA`;
const priceLabel = (amount, unit) => `${formatFCFA(amount)} ${UNIT_LABELS[unit] || UNIT_LABELS.month}`;

// Rôle de l'utilisateur dans la session, ou null s'il n'y participe pas.
function participantRole(session, userId) {
  if (!session || !userId) return null;
  if (idOf(session.familyId) === String(userId)) return "family";
  if (idOf(session.providerId) === String(userId)) return "provider";
  return null;
}

// Message tel qu'envoyé aux participants : jamais le contenu original d'un message bloqué.
function publicMessage(m) {
  const o = m && typeof m.toObject === "function" ? m.toObject() : { ...m };
  delete o.originalEncrypted;
  delete o.originalMessage;
  delete o.familyId;
  delete o.providerId;
  delete o._updated;
  return o;
}

function publicSession(s) {
  const o = s && typeof s.toObject === "function" ? s.toObject() : { ...s };
  return {
    _id: o._id,
    sessionId: o._id,
    offerId: o.offerId,
    providerId: o.providerId,
    status: o.status,
    closedReason: o.closedReason || null,
    closedBy: o.closedBy || null,
    startDate: o.startDate || null,
    isPaid: !!o.isPaid,
    startDateProposal: o.startDateProposal?.date ? { date: o.startDateProposal.date, by: o.startDateProposal.by, at: o.startDateProposal.at } : null,
    lastReadAt: o.lastReadAt || {},
    warnings: o.warnings || { family: 0, provider: 0 },
    lastMessageAt: o.lastMessageAt || null,
    createdAt: o.createdAt,
  };
}

// Filtre Mongo des messages d'une discussion visibles par un rôle.
// (offerId, providerId) identifie la discussion, y compris pour les anciens messages sans sessionId.
const visibleFilter = (session, role) => ({
  offerId: session.offerId,
  providerId: session.providerId,
  $or: [{ visibleTo: null }, { visibleTo: { $exists: false } }, { visibleTo: role }],
});

// Diffuse un message aux salons des rôles qui peuvent le voir, et signale la nouveauté
// à la boîte de réception (liste des conversations, compteur) des utilisateurs concernés.
function emitMessage(io, message, session = null) {
  if (!io || !message) return;
  const sessionId = idOf(message.sessionId || session?._id);
  if (!sessionId) return;
  const updated = !!message._updated;
  const m = publicMessage(message);
  const roles = m.visibleTo ? [m.visibleTo] : ROLES;
  const users = { family: idOf(message.familyId || session?.familyId), provider: idOf(message.providerId || session?.providerId) };
  for (const r of roles) {
    io.to(room(sessionId, r)).emit(updated ? "chat:message:update" : "chat:message", { ...m, sessionId });
    if (users[r]) io.to(`user:${users[r]}`).emit("chat:inbox", { offerId: String(m.offerId), sessionId });
  }
}

function emitSession(io, session) {
  if (!io || !session?._id) return;
  const s = publicSession(session);
  for (const r of ROLES) io.to(room(idOf(session._id), r)).emit("chat:session", s);
}

// Candidature mise à jour (étape, accord sur la mission, prix) : les deux participants
// de CETTE discussion seulement ; jamais les autres candidats.
function emitApplication(io, session, application) {
  if (!io || !session?._id || !application) return;
  const payload = { sessionId: idOf(session._id), offerId: idOf(session.offerId), application };
  for (const r of ROLES) io.to(room(idOf(session._id), r)).emit("chat:application", payload);
  for (const id of [session.familyId, session.providerId]) {
    if (id) io.to(`user:${idOf(id)}`).emit("chat:inbox", { offerId: payload.offerId, sessionId: payload.sessionId });
  }
}

function systemMessage(session, message, extra = {}) {
  return ChatMessage.create({
    sessionId: session._id || null, offerId: session.offerId, familyId: session.familyId, providerId: session.providerId,
    senderRole: "system", type: "system", message, ...extra,
  });
}

async function notify(userId, title, message, offerId, sessionId = null, type = "chat_message") {
  try {
    const metadata = sessionId ? { offerId, sessionId: idOf(sessionId) } : { offerId };
    await Notification.create({ userId, title, message, type, metadata });
  } catch (err) {
    console.error("notification chat", err);
  }
}

// Discussion d'un couple (offre, prestataire), ou null.
async function findSession(offerId, providerId) {
  if (!offerId || !providerId) return null;
  return ChatSession.findOne({ offerId: idOf(offerId), providerId: idOf(providerId) });
}

class LegacyIndexError extends Error {
  constructor() {
    super("Index unique { offerId: 1 } encore présent sur chatsessions : lancez scripts/migrate-chat-sessions.js");
    this.name = "LegacyIndexError";
  }
}

// Ouvre (idempotent) la discussion d'un couple (offre, prestataire), avec un message d'accueil ISD.
async function openSession(offer, providerId, { status = "discussion", welcome = WELCOME_DISCUSSION, sessionId = null } = {}) {
  const existing = await findSession(offer._id, providerId);
  if (existing) return existing;
  let session;
  try {
    session = await ChatSession.create({
      ...(sessionId ? { _id: sessionId } : {}),
      offerId: offer._id, familyId: idOf(offer.family), providerId: idOf(providerId), status, lastMessageAt: new Date(),
    });
  } catch (err) {
    if (err && err.code === 11000) {
      const again = await findSession(offer._id, providerId);
      if (again) return again;
      throw new LegacyIndexError();
    }
    throw err;
  }
  await systemMessage(session, welcome);
  return session;
}

// Ancien comportement : chat ouvert à l'accord, directement à l'état « active ».
const openChat = (offer, providerId) => openSession(offer, providerId, { status: "active", welcome: WELCOME });

// Ferme poliment une discussion (refus, retrait, autre prestataire choisi, offre fermée). Idempotent.
async function closeSession(io, session, { reason, by = "system", text }) {
  if (!session || session.status === "closed") return null;
  session.status = "closed";
  session.closedReason = reason;
  session.closedBy = by;
  session.lastMessageAt = new Date();
  await session.save();
  const msg = await systemMessage(session, text, { type: "discussion_closed", meta: { kind: "discussion_closed", reason, by } });
  emitMessage(io, msg, session);
  emitSession(io, session);
  return msg;
}

// Le destinataire a-t-il la discussion ouverte (socket dans le salon) ?
async function isInRoom(io, sessionId, role) {
  if (!io || !sessionId) return false;
  try {
    const sockets = await io.in(room(idOf(sessionId), role)).fetchSockets();
    return sockets.length > 0;
  } catch {
    return false;
  }
}

// Date au format « lundi 1 décembre 2026 ».
const formatDay = (d) => new Date(d).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

module.exports = {
  ROLES, WELCOME, WELCOME_DISCUSSION, UNIT_LABELS, otherRole, room, idOf, participantRole, publicMessage, publicSession,
  visibleFilter, emitMessage, emitSession, emitApplication, systemMessage, notify, findSession, openSession, openChat,
  closeSession, isInRoom, formatDay, formatFCFA, priceLabel, LegacyIndexError,
};
