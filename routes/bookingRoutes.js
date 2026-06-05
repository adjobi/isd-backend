const express = require("express");
const router = express.Router();

const bookingController = require("../controllers/bookingController");
const authMiddleware = require("../middleware/authMiddleware");

// créer réservation
router.post("/", authMiddleware, bookingController.createBooking);

// mes réservations (famille)
router.get("/me", authMiddleware, bookingController.getMyBookings);

// réservations d'une nounou
router.get("/nanny/:id", authMiddleware, bookingController.getNannyBookings);

// update status
router.put("/:id", authMiddleware, bookingController.updateBookingStatus);

module.exports = router;
