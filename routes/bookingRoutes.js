const express = require("express");
const router = express.Router();
const bookingController = require("../controllers/bookingController");
const authMiddleware = require("../middleware/authMiddleware");
// CREATE
router.post("/", authMiddleware, bookingController.createBooking);
// FAMILY
router.get("/family", authMiddleware, bookingController.getFamilyBookings);
// PROVIDER
router.get("/provider", authMiddleware, bookingController.getProviderBookings);
// ACTION
router.put("/:id/action", authMiddleware, bookingController.providerAction);
// FLOW
router.put("/:id/start", authMiddleware, bookingController.startService);
router.put("/:id/complete", authMiddleware, bookingController.completeService);
// CANCEL (rupture d'accord par la famille ou le prestataire)
router.put("/:id/cancel", authMiddleware, bookingController.cancelBooking);
module.exports = router;
