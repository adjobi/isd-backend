const Review = require("../models/Review");
const Nanny = require("../models/Nanny");
const mongoose = require("mongoose");

/* =========================
   ⭐ CREATE REVIEW
========================= */
exports.createReview = async (req, res) => {
  try {
    const userId = req.user.id;
    const { nannyId, rating, comment } = req.body;

    // validation rating
    if (rating < 1 || rating > 5) {
      return res.status(400).json({
        message: "Rating doit être entre 1 et 5",
      });
    }

    const nanny = await Nanny.findById(nannyId);

    if (!nanny) {
      return res.status(404).json({ message: "Nounou introuvable" });
    }

    const review = await Review.create({
      nannyId,
      userId,
      rating,
      comment,
    });

    res.status(201).json({
      message: "Avis ajouté avec succès",
      review,
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/* =========================
   📊 GET REVIEWS BY NANNY
========================= */
exports.getReviewsByNanny = async (req, res) => {
  try {
    const reviews = await Review.find({ nannyId: req.params.id })
      .populate("userId", "name email")
      .sort({ createdAt: -1 });

    res.json(reviews);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/* =========================
   👤 GET REVIEWS BY USER
========================= */
exports.getReviewsByUser = async (req, res) => {
  try {
    const reviews = await Review.find({ userId: req.params.id })
      .populate("nannyId", "name pricePerHour location")
      .sort({ createdAt: -1 });

    res.json(reviews);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/* =========================
   📈 GET AVERAGE RATING
========================= */
exports.getAverageRating = async (req, res) => {
  try {
    const nannyId = req.params.id;

    const reviews = await Review.find({ nannyId });

    if (reviews.length === 0) {
      return res.json({
        average: 0,
        count: 0,
      });
    }

    const sum = reviews.reduce((acc, review) => acc + review.rating, 0);
    const average = sum / reviews.length;

    res.json({
      average: Number(average.toFixed(1)),
      count: reviews.length,
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
