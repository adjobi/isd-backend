const express = require("express");
const router = express.Router();

const reviewController = require("../controllers/reviewController");
const authMiddleware = require("../middleware/authMiddleware");

// créer un avis
router.post("/", authMiddleware, reviewController.createReview);

// voir avis d'une nounou
router.get("/:id", reviewController.getNannyReviews);

module.exports = router;
