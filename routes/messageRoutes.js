const express = require("express");
const router = express.Router();

const messageController = require("../controllers/messageController");
const authMiddleware = require("../middleware/authMiddleware");

router.post("/", authMiddleware, messageController.sendMessage);
router.get("/:bookingId", authMiddleware, messageController.getChat);

module.exports = router;
