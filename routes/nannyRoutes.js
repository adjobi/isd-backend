const express = require("express");
const router = express.Router();

const nannyController = require("../controllers/nannyController");

// =====================================
// GET ALL PROVIDERS
// Query params:
// ?city=Abidjan
// ?type=nanny
// ?type=tutor
// ?subject=Maths
// ?minPrice=1000
// ?maxPrice=5000
// =====================================
router.get("/", nannyController.getNannies);

module.exports = router;
