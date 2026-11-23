// Temps réel (Socket.io) : connexion authentifiée par le jeton de l'app.
// Les salons de chat ne sont rejoints qu'après vérification côté serveur ;
// seul le serveur diffuse les messages (via les routes /api/chat).
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { ChatSession } = require("../models/Chat");
const { participantRole, otherRole, room } = require("../services/chat");

const onlineUsers = new Map(); // userId -> socket.id (dernière connexion)

function initSocket(io) {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.data.userId = String(decoded.id);
      socket.data.chats = new Map(); // offerId -> rôle
      return next();
    } catch {
      return next(new Error("Authentification requise"));
    }
  });

  const leave = (socket, offerId) => {
    const role = socket.data.chats.get(offerId);
    if (!role) return;
    socket.data.chats.delete(offerId);
    socket.leave(room(offerId, role));
    socket.to(room(offerId, otherRole(role))).emit("chat:presence", { offerId, role, online: false });
  };

  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    onlineUsers.set(userId, socket.id);
    socket.join(`user:${userId}`);

    socket.on("chat:join", async (offerId, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        if (typeof offerId !== "string" || !mongoose.Types.ObjectId.isValid(offerId)) return reply({ ok: false });
        const session = await ChatSession.findOne({ offerId }).select("familyId providerId").lean();
        const role = participantRole(session, userId);
        if (!role) return reply({ ok: false });
        socket.data.chats.set(offerId, role);
        socket.join(room(offerId, role));
        socket.to(room(offerId, otherRole(role))).emit("chat:presence", { offerId, role, online: true });
        const others = await io.in(room(offerId, otherRole(role))).fetchSockets();
        return reply({ ok: true, otherOnline: others.length > 0 });
      } catch (err) {
        console.error("chat:join", err.message);
        return reply({ ok: false });
      }
    });

    socket.on("chat:leave", (offerId) => leave(socket, offerId));

    socket.on("chat:typing", (payload) => {
      const offerId = payload?.offerId;
      const role = socket.data.chats.get(offerId);
      if (!role) return;
      socket.to(room(offerId, otherRole(role))).emit("chat:typing", { offerId, role, typing: !!payload.typing });
    });

    socket.on("disconnect", () => {
      for (const offerId of [...socket.data.chats.keys()]) leave(socket, offerId);
      if (onlineUsers.get(userId) === socket.id) onlineUsers.delete(userId);
    });
  });

  return onlineUsers;
}

module.exports = initSocket;
