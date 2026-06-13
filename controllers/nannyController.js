const User = require("../models/User");

exports.getNannies = async (req, res) => {
  try {
    const { city, minPrice, maxPrice, type, subject, availability, page = 1, limit = 20 } = req.query;

    let filter = {
      role: { $in: ["nanny", "tutor"] },
    };

    // TYPE FILTER — cherche dans role ET serviceType
    if (type) {
      filter.role = type; // nanny ou tutor
    }

    // CITY
    if (city) {
      filter.city = { $regex: city, $options: "i" };
    }

    // PRICE
    if (minPrice || maxPrice) {
      filter.pricingAmount = {};
      if (minPrice) filter.pricingAmount.$gte = Number(minPrice);
      if (maxPrice) filter.pricingAmount.$lte = Number(maxPrice);
    }

    // SUBJECT (tutor only)
    if (subject) {
      filter.subjects = { $in: [subject] };
    }

    // AVAILABILITY
    if (availability) {
      filter.availability = availability;
    }

    const skip = (page - 1) * limit;
    const providers = await User.find(filter)
      .select("-password")
      .skip(skip)
      .limit(Number(limit))
      .sort({ createdAt: -1 });

    const total = await User.countDocuments(filter);

    res.json(providers); // ✅ retourne directement le tableau
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
