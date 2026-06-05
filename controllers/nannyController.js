const Nanny = require("../models/Nanny");

// CREATE / UPDATE profil nounou
exports.createOrUpdateNanny = async (req, res) => {
  try {
    const userId = req.user.id;

    const {
      bio,
      services,
      hourlyRate,
      city,
      availability,
      experienceYears,
    } = req.body;

    let nanny = await Nanny.findOne({ userId });

    if (nanny) {
      // UPDATE
      nanny.bio = bio;
      nanny.services = services;
      nanny.hourlyRate = hourlyRate;
      nanny.city = city;
      nanny.availability = availability;
      nanny.experienceYears = experienceYears;

      await nanny.save();

      return res.json({
        message: "Profil nounou mis à jour",
        nanny,
      });
    }

    // CREATE
    nanny = await Nanny.create({
      userId,
      bio,
      services,
      hourlyRate,
      city,
      availability,
      experienceYears,
    });

    res.status(201).json({
      message: "Profil nounou créé",
      nanny,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET mon profil nounou
exports.getMyNannyProfile = async (req, res) => {
  try {
    const nanny = await Nanny.findOne({ userId: req.user.id });

    if (!nanny) {
      return res.status(404).json({
        message: "Profil nounou introuvable",
      });
    }

    res.json(nanny);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET toutes les nounous (marketplace)
exports.getAllNannies = async (req, res) => {
  try {
    const nannies = await Nanny.find().populate("userId", "name email");

    res.json(nannies);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
