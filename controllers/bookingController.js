const Booking = require("../models/Booking");

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
      { status: "in_progress" },
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
