const express = require("express");
const router = express.Router();

const notificationController = require("../controllers/notificationController");
const authMiddleware = require("../middleware/authMiddleware");

// ======================================
// GET USER NOTIFICATIONS
// ======================================
router.get(
  "/",
  authMiddleware,
  notificationController.getNotifications
);

// ======================================
// GET UNREAD COUNT
// ======================================
router.get(
  "/unread-count",
  authMiddleware,
  notificationController.getUnreadCount
);

// ======================================
// MARK ONE AS READ
// ======================================
router.put(
  "/:id/read",
  authMiddleware,
  notificationController.markAsRead
);

// ======================================
// MARK ALL AS READ
// ======================================
router.put(
  "/read-all",
  authMiddleware,
  notificationController.markAllAsRead
);

module.exports = router;
