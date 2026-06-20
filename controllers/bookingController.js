const Booking = require("../models/Booking");
const Notification = require("../models/Notification");

// ======================
// HELPER: notifier l'autre partie (DB + socket temps réel)
// ======================
async function notifyUser(req, { userId, title, message, type, bookingId }) {
  const notification = await Notification.create({
    userId,
    title,
    message,
    type,
    relatedBookingId: bookingId,
    channel: "inapp",
  });

  const io = req.app.get("io");
  const onlineUsers = req.app.get("onlineUsers");
  const socketId = onlineUsers?.get(String(userId));
  if (io && socketId) {
    io.to(socketId).emit("new_notification", notification);
  }
  return notification;
}

// ======================
// CREATE BOOKING
// ======================
exports.createBooking = async (req, res) => {
  try {
    const io = req.app.get("io");
    const onlineUsers = req.app.get("onlineUsers");
    const { providerId, type, description, city, price } = req.body;
    const booking = await Booking.create({
      familyId: req.user.id,
      providerId,
      type,
      description,
      city,
      price,
      status: "pending",
    });
    const providerSocket = onlineUsers.get(providerId);
    if (providerSocket) {
      io.to(providerSocket).emit("new_booking", {
        message: "Nouvelle demande de réservation",
        booking,
      });
    }
    res.status(201).json({
      message: "Booking envoyé + notification live",
      booking,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================
// FAMILY BOOKINGS
// ======================
exports.getFamilyBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({
      familyId: req.user.id,
    }).populate("providerId");
    res.json(bookings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================
// PROVIDER BOOKINGS
// ======================
exports.getProviderBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({
      providerId: req.user.id,
    }).populate("familyId");
    res.json(bookings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================
// PROVIDER ACTION (ACCEPT / REJECT)
// ======================
exports.providerAction = async (req, res) => {
  try {
    const { status } = req.body;
    const booking = await Booking.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    res.json(booking);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================
// START SERVICE
// ======================
exports.startService = async (req, res) => {
  try {
    const booking = await Booking.findByIdAndUpdate(
      req.params.id,
      { status: "active" },
      { new: true }
    );
    res.json(booking);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================
// COMPLETE SERVICE
// ======================
exports.completeService = async (req, res) => {
  try {
    const booking = await Booking.findByIdAndUpdate(
      req.params.id,
      { status: "completed" },
      { new: true }
    );
    res.json(booking);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================
// CANCEL BOOKING (rupture d'accord par la famille ou le prestataire)
// ======================
exports.cancelBooking = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({ message: "Réservation introuvable" });
    }

    const userId = String(req.user.id);
    const isFamily = String(booking.familyId) === userId;
    const isProvider = String(booking.providerId) === userId;

    if (!isFamily && !isProvider) {
      return res.status(403).json({
        message: "Vous n'êtes pas autorisé à modifier cette réservation",
      });
    }

    if (["completed", "cancelled", "rejected"].includes(booking.status)) {
      return res.status(400).json({
        message: `Impossible d'annuler une réservation déjà ${booking.status === "completed" ? "terminée" : "annulée"}`,
      });
    }

    booking.status = "cancelled";
    await booking.save();

    // Identifier l'autre partie à notifier
    const otherPartyId = isFamily ? booking.providerId : booking.familyId;
    const initiatorLabel = isFamily ? "la famille" : "le prestataire";

    await notifyUser(req, {
      userId: otherPartyId,
      title: "Réservation annulée",
      message: `${initiatorLabel.charAt(0).toUpperCase() + initiatorLabel.slice(1)} a mis fin à votre collaboration pour cette réservation.`,
      type: "booking_cancelled",
      bookingId: booking._id,
    });

    res.json({
      message: "Réservation annulée avec succès",
      booking,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
