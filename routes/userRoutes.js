const express = require("express");
const router = express.Router();

const User = require("../models/User");

// 🔍 GET ALL USERS (filter role/city)
router.get("/", async (req, res) => {
  try {
    const { role, city } = req.query;

    let filter = {};

    if (role) filter.role = role;
    if (city) filter["location.city"] = city;

    const users = await User.find(filter).select("-password");

    res.json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 🔍 GET ONE USER
router.get("/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password");

    if (!user) {
      return res.status(404).json({ message: "Utilisateur introuvable" });
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
