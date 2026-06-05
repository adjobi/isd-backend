const Review = require("../models/Review");
const Nanny = require("../models/Nanny");

// CREATE review
exports.createReview = async (req, res) => {
  try {
    const familyId = req.user.id;
    const { nannyId, bookingId, rating, comment } = req.body;

    const review = await Review.create({
      familyId,
      nannyId,
      bookingId,
      rating,
      comment,
    });

    // recalcul rating nanny
    const reviews = await Review.find({ nannyId });

    const avgRating =
      reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length;

    await Nanny.findByIdAndUpdate(nannyId, {
      rating: avgRating,
      reviewsCount: reviews.length,
    });

    res.status(201).json({
      message: "Avis ajouté",
      review,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET reviews d'une nounou
exports.getNannyReviews = async (req, res) => {
  try {
    const reviews = await Review.find({ nannyId: req.params.id })
      .populate("familyId", "name")
      .sort({ createdAt: -1 });

    res.json(reviews);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
