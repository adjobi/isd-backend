const Message = require("../models/Message");

// ======================
// SEND MESSAGE
// ======================
exports.sendMessage = async (req, res) => {
  try {
    const { receiverId, bookingId, message } = req.body;

    const newMessage = await Message.create({
      senderId: req.user.id,
      receiverId,
      bookingId,
      message,
    });

    // REAL-TIME SOCKET
    const io = req.app.get("io");
    const onlineUsers = req.app.get("onlineUsers");

    const receiverSocketId = onlineUsers.get(receiverId);

    if (receiverSocketId) {
      io.to(receiverSocketId).emit("newMessage", newMessage);
    }

    res.status(201).json({
      message: "Message envoyé",
      data: newMessage,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================
// GET CHAT BY BOOKING
// ======================
exports.getChat = async (req, res) => {
  try {
    const { bookingId } = req.params;

    const messages = await Message.find({ bookingId })
      .sort({ createdAt: 1 });

    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
