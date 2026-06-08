const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ===============================
// REGISTER (CLEAN MARKETPLACE ISD)
// ===============================
exports.register = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      password,
      role,
      phone,
      city,
      serviceType,
      pricingType,
      pricingAmount,
      subjects,
    } = req.body;

    if (!firstName || !lastName || !email || !password || !phone || !city) {
      return res.status(400).json({ message: "Champs obligatoires manquants" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const exist = await User.findOne({ email: normalizedEmail });
    if (exist) {
      return res.status(400).json({ message: "Utilisateur existe déjà" });
    }

    const hashed = await bcrypt.hash(password, 10);

    const user = await User.create({
      firstName,
      lastName,
      email: normalizedEmail,
      password: hashed,
      role,
      phone,
      city,
      ...(role !== "family" && { serviceType, pricingType, pricingAmount }),
      ...(role === "tutor" && { subjects: subjects || [] }),
      isProfileCompleted: false,
    });

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(201).json({
      message: "Utilisateur créé",
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        phone: user.phone,
        city: user.city,
        serviceType: user.serviceType,
        pricingType: user.pricingType,
        pricingAmount: user.pricingAmount,
        subjects: user.subjects,
        availability: user.availability,
        isProfileCompleted: user.isProfileCompleted,
      },
    });

  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ===============================
// LOGIN
// ===============================
exports.login = async (req, res) => {
  try {
    const { email, password, role } = req.body; // ✅ on récupère le rôle attendu

    const normalizedEmail = email.toLowerCase().trim();

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ message: "Utilisateur introuvable" });
    }

    // ✅ VÉRIFICATION DU RÔLE
    // Si un rôle est fourni par le frontend, on vérifie qu'il correspond
    if (role && user.role !== role) {
      return res.status(403).json({
        message: `Ce compte est un compte "${user.role}". Veuillez vous connecter depuis le bon profil.`,
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ message: "Mot de passe incorrect" });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      message: "Connexion réussie",
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        phone: user.phone,
        city: user.city,
        serviceType: user.serviceType,
        pricingType: user.pricingType,
        pricingAmount: user.pricingAmount,
        subjects: user.subjects,
        availability: user.availability,
        isProfileCompleted: user.isProfileCompleted,
      },
    });

  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};
