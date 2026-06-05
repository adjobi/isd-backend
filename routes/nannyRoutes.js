const express = require("express");
const router = express.Router();

const nannyController = require("../controllers/nannyController");
const authMiddleware = require("../middleware/authMiddleware");

// créer / update profil
router.post("/", authMiddleware, nannyController.createOrUpdateNanny);

// mon profil
router.get("/me", authMiddleware, nannyController.getMyNannyProfile);

// marketplace
router.get("/", nannyController.getAllNannies);

module.exports = router;
