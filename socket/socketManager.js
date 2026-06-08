const onlineUsers = new Map();

function initSocket(io) {
  io.on("connection", (socket) => {
    console.log("🟢 user connected:", socket.id);

    // =========================
    // REGISTER USER
    // =========================
    socket.on("register", (userId) => {
      if (!userId) return;

      onlineUsers.set(userId.toString(), socket.id);

      socket.userId = userId;

      console.log("👤 registered:", userId);
    });

    // =========================
    // JOIN BOOKING ROOM
    // =========================
    socket.on("join_booking_room", (bookingId) => {
      if (!bookingId) return;

      socket.join(`booking_${bookingId}`);

      console.log("📦 joined room:", bookingId);
    });

    // =========================
    // LEAVE BOOKING ROOM
    // =========================
    socket.on("leave_booking_room", (bookingId) => {
      if (!bookingId) return;

      socket.leave(`booking_${bookingId}`);

      console.log("🚪 left room:", bookingId);
    });

    // =========================
    // REAL TIME MESSAGE (FUTURE CHAT)
    // =========================
    socket.on("send_message", ({ bookingId, message }) => {
      if (!bookingId || !message) return;

      io.to(`booking_${bookingId}`).emit("new_message", {
        senderId: socket.userId,
        message,
        createdAt: new Date(),
      });
    });

    // =========================
    // DISCONNECT
    // =========================
    socket.on("disconnect", () => {
      if (socket.userId) {
        onlineUsers.delete(socket.userId.toString());
      }

      console.log("🔴 disconnected:", socket.id);
    });
  });

  return onlineUsers;
}

module.exports = initSocket;
