const express = require("express");
const router = express.Router();

const searchController = require("../controllers/searchController");

// recherche publique (pas besoin de login)
router.get("/nannies", searchController.searchNannies);

module.exports = router;
