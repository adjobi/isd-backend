const express = require("express");
const router = express.Router();

const {
  register,
  login,
} = require("../controllers/authController");

const authMiddleware = require("../middleware/authMiddleware");

// ======================
// AUTH PUBLIC
// ======================
router.post("/register", register);
router.post("/login", login);

// ======================
// AUTH PROTECTED
// ======================

// GET CURRENT USER
router.get("/me", authMiddleware, (req, res) => {
  res.json({
    message: "Utilisateur connecté",
    user: req.user,
  });
});

module.exports = router;
