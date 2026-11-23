// Actions en attente de l'utilisateur connecté (accueil, écran « Mission »).
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { pendingActions } = require("../services/actions");

router.get("/", auth, async (req, res) => {
  try {
    const actions = await pendingActions(req.user.id, req.user.role);
    return res.json({ actions });
  } catch (err) {
    console.error("actions", err);
    return res.status(500).json({ message: "Erreur serveur. Réessayez dans un instant." });
  }
});

module.exports = router;
