const Booking = require("../models/Booking");
const Nanny = require("../models/Nanny");

// CREATE booking (famille réserve une nounou)
exports.createBooking = async (req, res) => {
  try {
    const familyId = req.user.id;
    const { nannyId, date, durationHours, location } = req.body;

    const nanny = await Nanny.findById(nannyId);

    if (!nanny) {
      return res.status(404).json({ message: "Nounou introuvable" });
    }

    const price = nanny.hourlyRate * durationHours;

    const booking = await Booking.create({
      familyId,
      nannyId,
      date,
      durationHours,
      location,
      price,
    });

    res.status(201).json({
      message: "Réservation créée",
      booking,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET bookings de la famille
exports.getMyBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ familyId: req.user.id })
      .populate("nannyId")
      .sort({ createdAt: -1 });

    res.json(bookings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET bookings de la nounou
exports.getNannyBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ nannyId: req.params.id })
      .populate("familyId", "name email")
      .sort({ createdAt: -1 });

    res.json(bookings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// UPDATE status (accept / reject / complete)
exports.updateBookingStatus = async (req, res) => {
  try {
    const { status } = req.body;

    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({ message: "Réservation introuvable" });
    }

    booking.status = status;
    await booking.save();

    res.json({
      message: "Statut mis à jour",
      booking,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
