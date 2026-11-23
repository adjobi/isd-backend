// Logique partagée du chat à trois (famille, prestataire, système ISD).
const { ChatMessage, ChatSession } = require("../models/Chat");
const Notification = require("../models/Notification");

const ROLES = ["family", "provider"];
const otherRole = (role) => (role === "family" ? "provider" : "family");
const room = (offerId, role) => `chat:${offerId}:${role}`;
const idOf = (v) => (v && v._id ? v._id : v)?.toString();

const WELCOME = [
  "Bienvenue dans votre chat ISD 👋",
  "Prenez le temps de vous présenter, de préciser les horaires, les tâches et le lieu, puis convenez d'une date de début avec le bouton « Date » en haut de l'écran.",
  "Pour votre sécurité, téléphone, email, liens et réseaux sociaux sont interdits ici : ils sont échangés automatiquement après le paiement de la facture ISD.",
].join("\n\n");

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
  return o;
}

function publicSession(s) {
  const o = s && typeof s.toObject === "function" ? s.toObject() : { ...s };
  return {
    offerId: o.offerId,
    status: o.status,
    closedReason: o.closedReason || null,
    startDate: o.startDate || null,
    isPaid: !!o.isPaid,
    startDateProposal: o.startDateProposal?.date ? { date: o.startDateProposal.date, by: o.startDateProposal.by, at: o.startDateProposal.at } : null,
    lastReadAt: o.lastReadAt || {},
    warnings: o.warnings || { family: 0, provider: 0 },
    createdAt: o.createdAt,
  };
}

// Filtre Mongo des messages visibles par un rôle.
const visibleFilter = (offerId, role) => ({ offerId, $or: [{ visibleTo: null }, { visibleTo: { $exists: false } }, { visibleTo: role }] });

// Diffuse un message aux salons des rôles qui peuvent le voir, et signale la nouveauté
// à la boîte de réception (liste des conversations, compteur) des utilisateurs concernés.
function emitMessage(io, message) {
  if (!io || !message) return;
  const m = publicMessage(message);
  const roles = m.visibleTo ? [m.visibleTo] : ROLES;
  const users = { family: idOf(message.familyId), provider: idOf(message.providerId) };
  for (const r of roles) {
    io.to(room(m.offerId, r)).emit(m._updated ? "chat:message:update" : "chat:message", m);
    if (users[r]) io.to(`user:${users[r]}`).emit("chat:inbox", { offerId: String(m.offerId) });
  }
}

function emitSession(io, session) {
  if (!io || !session) return;
  const s = publicSession(session);
  for (const r of ROLES) io.to(room(s.offerId, r)).emit("chat:session", s);
}

function systemMessage(session, message, extra = {}) {
  return ChatMessage.create({
    offerId: session.offerId, familyId: session.familyId, providerId: session.providerId,
    senderRole: "system", type: "system", message, ...extra,
  });
}

async function notify(userId, title, message, offerId) {
  try {
    await Notification.create({ userId, title, message, type: "chat_message", metadata: { offerId } });
  } catch (err) {
    console.error("notification chat", err);
  }
}

// Ouvre le chat d'une offre conclue (idempotent). Message d'accueil ISD à la création.
async function openChat(offer, providerId) {
  const existing = await ChatSession.findOne({ offerId: offer._id });
  if (existing) return existing;
  let session;
  try {
    session = await ChatSession.create({ offerId: offer._id, familyId: idOf(offer.family), providerId: idOf(providerId), lastMessageAt: new Date() });
  } catch (err) {
    if (err && err.code === 11000) return ChatSession.findOne({ offerId: offer._id });
    throw err;
  }
  await systemMessage(session, WELCOME);
  return session;
}

// Le destinataire a-t-il le chat ouvert (socket dans le salon) ?
async function isInRoom(io, offerId, role) {
  if (!io) return false;
  try {
    const sockets = await io.in(room(offerId, role)).fetchSockets();
    return sockets.length > 0;
  } catch {
    return false;
  }
}

// Date au format « lundi 1 décembre 2026 ».
const formatDay = (d) => new Date(d).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

module.exports = {
  ROLES, WELCOME, otherRole, room, idOf, participantRole, publicMessage, publicSession, visibleFilter,
  emitMessage, emitSession, systemMessage, notify, openChat, isInRoom, formatDay,
};
