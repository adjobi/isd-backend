const Nanny = require("../models/Nanny");

// SEARCH NANNIES (filtre intelligent)
exports.searchNannies = async (req, res) => {
  try {
    const { city, service, minPrice, maxPrice } = req.query;

    let filters = {};

    // filtre ville
    if (city) {
      filters.city = { $regex: city, $options: "i" };
    }

    // filtre prix
    if (minPrice || maxPrice) {
      filters.hourlyRate = {};
      if (minPrice) filters.hourlyRate.$gte = Number(minPrice);
      if (maxPrice) filters.hourlyRate.$lte = Number(maxPrice);
    }

    // filtre service
    if (service) {
      filters.services = { $in: [service] };
    }

    const nannies = await Nanny.find(filters).populate(
      "userId",
      "name email"
    );

    res.json({
      count: nannies.length,
      results: nannies,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
