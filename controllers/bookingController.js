const Booking = require("../models/Booking");
const Notification = require("../models/Notification");
const BookingReview = require("../models/BookingReview");

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
// Exclut les réservations que la famille a retirées de son historique.
// ======================
exports.getFamilyBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({
      familyId: req.user.id,
      familyHidden: { $ne: true },
    }).populate("providerId");
    res.json(bookings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================
// PROVIDER BOOKINGS
// Exclut les réservations que le prestataire a retirées de son historique.
// ======================
exports.getProviderBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({
      providerId: req.user.id,
      providerHidden: { $ne: true },
    }).populate("familyId");
    res.json(bookings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================
// MISSIONS TERMINÉES (prestataire)
// Pour affichage dans le profil enrichi
// ======================
exports.getCompletedMissions = async (req, res) => {
  try {
    const missions = await Booking.find({
      providerId: req.user.id,
      status: "completed",
    })
      .populate("familyId", "firstName lastName city")
      .sort({ updatedAt: -1 });

    res.json(missions);
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
// Enregistre automatiquement la date de début de mission (une seule fois).
// ======================
exports.startService = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Réservation introuvable" });
    }

    booking.status = "active";
    if (!booking.startDate) {
      booking.startDate = new Date();
    }
    await booking.save();

    res.json(booking);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================
// COMPLETE SERVICE
// Enregistre automatiquement la date de fin de mission.
// ======================
exports.completeService = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Réservation introuvable" });
    }

    const now = new Date();
    booking.status = "completed";
    booking.endDate = now;
    if (!booking.startDate) {
      booking.startDate = now;
    }
    await booking.save();

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

// ======================
// RETIRER DE L'HISTORIQUE (par profil, sans supprimer pour l'autre partie)
// Disponible uniquement pour les réservations terminées : completed,
// cancelled ou rejected (pas pour une mission encore active/en attente).
// ======================
exports.hideBooking = async (req, res) => {
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

    if (!["completed", "cancelled", "rejected"].includes(booking.status)) {
      return res.status(400).json({
        message: "Vous ne pouvez retirer de l'historique qu'une réservation terminée ou annulée",
      });
    }

    if (isFamily) booking.familyHidden = true;
    if (isProvider) booking.providerHidden = true;
    await booking.save();

    res.json({ message: "Réservation retirée de votre historique" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================
// NOTER LA COLLABORATION (après une mission terminée)
// Chaque partie peut noter l'autre une seule fois par réservation.
// ======================
exports.submitReview = async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const ratingNum = Number(rating);

    if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ message: "La note doit être comprise entre 1 et 5" });
    }

    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Réservation introuvable" });
    }

    if (booking.status !== "completed") {
      return res.status(400).json({
        message: "Vous ne pouvez noter qu'une collaboration terminée",
      });
    }

    const userId = String(req.user.id);
    const isFamily = String(booking.familyId) === userId;
    const isProvider = String(booking.providerId) === userId;

    if (!isFamily && !isProvider) {
      return res.status(403).json({
        message: "Vous n'êtes pas autorisé à noter cette collaboration",
      });
    }

    if ((isFamily && booking.familyReviewed) || (isProvider && booking.providerReviewed)) {
      return res.status(400).json({ message: "Vous avez déjà noté cette collaboration" });
    }

    const toUserId = isFamily ? booking.providerId : booking.familyId;
    const fromRole = isFamily ? "family" : "provider";

    const review = await BookingReview.create({
      bookingId: booking._id,
      fromUserId: req.user.id,
      toUserId,
      fromRole,
      rating: ratingNum,
      comment: comment || "",
    });

    if (isFamily) booking.familyReviewed = true;
    if (isProvider) booking.providerReviewed = true;
    await booking.save();

    await notifyUser(req, {
      userId: toUserId,
      title: "Nouvelle note reçue ⭐",
      message: "Vous avez reçu une note pour une collaboration terminée.",
      type: "review_received",
      bookingId: booking._id,
    });

    res.status(201).json({ message: "Note envoyée, merci !", review, booking });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Vous avez déjà noté cette collaboration" });
    }
    res.status(500).json({ message: error.message });
  }
};
