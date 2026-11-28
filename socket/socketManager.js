// Temps réel (Socket.io) : connexion authentifiée par le jeton de l'app.
// Les salons de chat (un par discussion et par rôle) ne sont rejoints qu'après vérification
// côté serveur ; seul le serveur diffuse les messages (via les routes /api/chat et /api/offers).
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { ChatSession } = require("../models/Chat");
const Offer = require("../models/Offer");
const { participantRole, otherRole, room, idOf } = require("../services/chat");

const onlineUsers = new Map(); // userId -> socket.id (dernière connexion)
const isProviderRole = (role) => role === "nanny" || role === "tutor";
const rawId = (payload) => (payload && typeof payload === "object" ? payload.sessionId || payload.offerId : payload);

// Discussion demandée : { sessionId } (ou son identifiant seul) ; ancienne app : identifiant d'offre,
// résolu vers la discussion de l'utilisateur (prestataire : la sienne ; famille : celle de l'accord).
async function resolveSession(payload, user) {
  const raw = rawId(payload);
  if (typeof raw !== "string" || !mongoose.Types.ObjectId.isValid(raw)) return null;
  const fields = "offerId familyId providerId";
  const byId = await ChatSession.findById(raw).select(fields).lean();
  if (byId) return byId;
  let providerId = isProviderRole(user.role) ? user.id : null;
  if (!providerId) {
    const offer = await Offer.findById(raw).select("acceptedProvider").lean();
    providerId = idOf(offer?.acceptedProvider);
  }
  if (!providerId) return null;
  return ChatSession.findOne({ offerId: raw, providerId }).select(fields).lean();
}

function initSocket(io) {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.data.userId = String(decoded.id);
      socket.data.role = decoded.role;
      socket.data.chats = new Map(); // sessionId -> { role, offerId }
      return next();
    } catch {
      return next(new Error("Authentification requise"));
    }
  });

  // Identifiant reçu du client → discussion déjà rejointe par ce socket (sessionId ou ancien offerId).
  const joinedKey = (socket, payload) => {
    const raw = rawId(payload);
    if (typeof raw !== "string") return null;
    if (socket.data.chats.has(raw)) return raw;
    for (const [sid, c] of socket.data.chats) if (c.offerId === raw) return sid;
    return null;
  };

  const leave = (socket, sessionId) => {
    const c = socket.data.chats.get(sessionId);
    if (!c) return;
    socket.data.chats.delete(sessionId);
    socket.leave(room(sessionId, c.role));
    socket.to(room(sessionId, otherRole(c.role))).emit("chat:presence", { sessionId, offerId: c.offerId, role: c.role, online: false });
  };

  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    onlineUsers.set(userId, socket.id);
    socket.join(`user:${userId}`);

    socket.on("chat:join", async (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        const session = await resolveSession(payload, { id: userId, role: socket.data.role });
        const role = participantRole(session, userId);
        if (!role) return reply({ ok: false });
        const sessionId = idOf(session._id);
        const offerId = idOf(session.offerId);
        socket.data.chats.set(sessionId, { role, offerId });
        socket.join(room(sessionId, role));
        socket.to(room(sessionId, otherRole(role))).emit("chat:presence", { sessionId, offerId, role, online: true });
        const others = await io.in(room(sessionId, otherRole(role))).fetchSockets();
        return reply({ ok: true, sessionId, offerId, role, otherOnline: others.length > 0 });
      } catch (err) {
        console.error("chat:join", err.message);
        return reply({ ok: false });
      }
    });

    socket.on("chat:leave", (payload) => {
      const key = joinedKey(socket, payload);
      if (key) leave(socket, key);
    });

    socket.on("chat:typing", (payload) => {
      const key = joinedKey(socket, payload);
      if (!key) return;
      const c = socket.data.chats.get(key);
      socket.to(room(key, otherRole(c.role))).emit("chat:typing", { sessionId: key, offerId: c.offerId, role: c.role, typing: !!payload?.typing });
    });

    socket.on("disconnect", () => {
      for (const sessionId of [...socket.data.chats.keys()]) leave(socket, sessionId);
      if (onlineUsers.get(userId) === socket.id) onlineUsers.delete(userId);
    });
  });

  return onlineUsers;
}

module.exports = initSocket;
module.exports.resolveSession = resolveSession;
