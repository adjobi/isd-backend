const User = require("../models/User");

// ===============================
// GET NANNIES / TUTORS MARKETPLACE
// ===============================
exports.getNannies = async (req, res) => {
  try {
    const {
      city,
      minPrice,
      maxPrice,
      type,
      subject,
      availability,
      page = 1,
      limit = 20,
    } = req.query;

    let filter = {
      role: { $in: ["nanny", "tutor"] },
    };

    // ======================
    // CITY (CASE INSENSITIVE)
    // ======================
    if (city) {
      filter.city = { $regex: city, $options: "i" };
    }

    // ======================
    // TYPE FILTER
    // ======================
    if (type) {
      filter.serviceType = type;
    }

    // ======================
    // PRICE RANGE
    // ======================
    if (minPrice || maxPrice) {
      filter.pricingAmount = {};
      if (minPrice) filter.pricingAmount.$gte = Number(minPrice);
      if (maxPrice) filter.pricingAmount.$lte = Number(maxPrice);
    }

    // ======================
    // SUBJECT FILTER (TUTOR ONLY)
    // ======================
    if (subject && type === "tutor") {
      filter.subjects = { $in: [subject] };
    }

    // ======================
    // AVAILABILITY FILTER
    // ======================
    if (availability) {
      filter.availability = availability;
    }

    // ======================
    // PAGINATION
    // ======================
    const skip = (page - 1) * limit;

    const providers = await User.find(filter)
      .select("-password")
      .skip(skip)
      .limit(Number(limit))
      .sort({ createdAt: -1 });

    const total = await User.countDocuments(filter);

    // ======================
    // RESPONSE
    // ======================
    res.json({
      data: providers,
      pagination: {
        total,
        page: Number(page),
        pages: Math.ceil(total / limit),
      },
    });

  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};
