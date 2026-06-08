const express = require("express");
const router = express.Router();

const reviewController = require("../controllers/reviewController");
const authMiddleware = require("../middleware/authMiddleware");

// ⭐ create review
router.post("/", authMiddleware, reviewController.createReview);

// 📊 get reviews by nanny
router.get("/nanny/:id", reviewController.getReviewsByNanny);

module.exports = router;
