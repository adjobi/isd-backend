const User = require("../models/User");

exports.getNannies = async (req, res) => {
  try {
    const { city, minPrice, maxPrice, type, subject, availability, page = 1, limit = 20 } = req.query;

    // La recherche par ville est obligatoire : on ne liste jamais
    // tous les prestataires sans qu'une famille ait précisé une ville.
    if (!city || !city.trim()) {
      return res.status(400).json({ message: "Veuillez indiquer une ville pour lancer la recherche" });
    }

    let filter = {
      role: { $in: ["nanny", "tutor"] },
      city: { $regex: city.trim(), $options: "i" },
    };

    // TYPE FILTER — cherche dans role ET serviceType
    if (type) {
      filter.role = type; // nanny ou tutor
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

    res.json(providers); // ✅ retourne directement le tableau
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
