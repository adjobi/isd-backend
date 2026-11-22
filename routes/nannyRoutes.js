const express = require("express");
const router = express.Router();

const nannyController = require("../controllers/nannyController");
const auth = require("../middleware/authMiddleware");
const requireRole = require("../middleware/requireRole");

// =====================================
// RECHERCHE DE PRESTATAIRES (familles connectées uniquement)
// Query params :
// ?city=Abidjan (obligatoire)
// ?type=nanny | tutor
// ?subject=Mathématiques
// ?minPrice=1000 & ?maxPrice=5000
// ?availability=available | busy | away
// ?page=1 & ?limit=20 (max 50)
// Les coordonnées (téléphone, email) ne sont jamais renvoyées.
// =====================================
router.get("/", auth, requireRole("family"), nannyController.getNannies);

module.exports = router;
