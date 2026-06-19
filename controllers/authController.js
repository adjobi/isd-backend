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

    // ===== Validation détaillée par champ =====
    const errors = {};

    if (!firstName || !firstName.trim()) errors.firstName = "Le prénom est obligatoire";
    if (!lastName || !lastName.trim()) errors.lastName = "Le nom est obligatoire";
    if (!email || !email.trim()) {
      errors.email = "L'email est obligatoire";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errors.email = "Format d'email invalide";
    }
    if (!password) {
      errors.password = "Le mot de passe est obligatoire";
    } else if (password.length < 8) {
      errors.password = "Le mot de passe doit contenir au moins 8 caractères";
    }
    if (!phone || !phone.trim()) errors.phone = "Le téléphone est obligatoire";
    if (!city || !city.trim()) errors.city = "La ville est obligatoire";

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({
        message: "Merci de corriger les champs en surbrillance",
        errors,
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const exist = await User.findOne({ email: normalizedEmail });
    if (exist) {
      return res.status(400).json({
        message: "Un compte existe déjà avec cet email",
        errors: { email: "Cet email est déjà utilisé" },
      });
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
      message: "Compte créé avec succès",
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

    if (!email || !email.trim()) {
      return res.status(400).json({
        message: "L'email est obligatoire",
        errors: { email: "L'email est obligatoire" },
      });
    }
    if (!password) {
      return res.status(400).json({
        message: "Le mot de passe est obligatoire",
        errors: { password: "Le mot de passe est obligatoire" },
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({
        message: "Aucun compte ne correspond à cet email",
        errors: { email: "Aucun compte ne correspond à cet email" },
      });
    }

    // ✅ VÉRIFICATION DU RÔLE
    // Si un rôle est fourni par le frontend, on vérifie qu'il correspond
    if (role && user.role !== role) {
      return res.status(403).json({
        message: `Ce compte est un compte "${user.role}". Veuillez vous connecter depuis le bon profil.`,
        errors: { role: `Ce compte est un compte "${user.role}"` },
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({
        message: "Mot de passe incorrect",
        errors: { password: "Mot de passe incorrect" },
      });
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
