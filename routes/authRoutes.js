const express = require("express");
const router = express.Router();
const { register, login } = require("../controllers/authController");
const authMiddleware = require("../middleware/authMiddleware");
const User = require("../models/User");

// ======================
// AUTH PUBLIC
// ======================
router.post("/register", register);
router.post("/login", login);

// ======================
// AUTH PROTECTED
// ======================
router.get("/me", authMiddleware, (req, res) => {
  res.json({
    message: "Utilisateur connecté",
    user: req.user,
  });
});

// ======================
// METTRE À JOUR DISPONIBILITÉ
// ======================
router.put("/availability", authMiddleware, async (req, res) => {
  try {
    const { availability } = req.body;
    if (!["available", "busy", "away"].includes(availability)) {
      return res.status(400).json({ message: "Statut invalide" });
    }
    await User.findByIdAndUpdate(req.user.id, { availability });
    return res.json({ message: "Disponibilité mise à jour" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;
