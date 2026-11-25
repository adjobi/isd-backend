const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const throttle = require("../services/loginThrottle");
const twoFactor = require("../services/twoFactor");

// Durée des sessions : 7 jours pour l'app, 12 h pour l'Espace ISD (droits d'administration).
const SESSION = "7d";
const TEAM_SESSION = "12h";
// Message unique : ne révèle jamais si l'email existe ou si c'est le mot de passe qui est faux.
const BAD_CREDENTIALS = "Email ou mot de passe incorrect.";
// Comparaison factice quand le compte n'existe pas : même temps de réponse (pas d'indice).
const DUMMY_HASH = bcrypt.hashSync("isd-compte-inexistant", 10);

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
      { expiresIn: SESSION }
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
        isAdmin: !!user.isAdmin,
      },
    });

  } catch (err) {
    console.error("register", err);
    return res.status(500).json({ message: "Inscription impossible pour le moment. Réessayez." });
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
    const ip = req.ip || "inconnue";

    // Trop de tentatives : on refuse sans même vérifier le mot de passe.
    const wait = throttle.check(ip, normalizedEmail);
    if (wait) {
      res.set("Retry-After", String(wait));
      return res.status(429).json({
        message: `Trop de tentatives de connexion. Réessayez dans ${Math.ceil(wait / 60)} min.`,
      });
    }
    throttle.attempt(ip);

    const user = await User.findOne({ email: normalizedEmail });
    const match = await bcrypt.compare(String(password), user ? user.password : DUMMY_HASH);
    if (!user || !match) {
      throttle.failure(normalizedEmail);
      return res.status(401).json({ message: BAD_CREDENTIALS });
    }
    throttle.success(normalizedEmail);

    // Le profil et les droits ne sont indiqués qu'après un mot de passe correct.
    // Connexion « Équipe ISD » : n'importe quel profil, mais administrateur obligatoire.
    const teamLogin = role === "team";
    if (role && !teamLogin && user.role !== role) {
      return res.status(403).json({
        message: `Ce compte est un compte "${user.role}". Veuillez vous connecter depuis le bon profil.`,
        errors: { role: `Ce compte est un compte "${user.role}"` },
      });
    }
    if (teamLogin && !user.isAdmin) {
      return res.status(403).json({
        message: "Accès réservé à l'équipe ISD.",
        errors: { role: "Ce compte n'a pas les droits d'administration" },
      });
    }

    // Double authentification active : le mot de passe ne suffit pas, on demande le code
    // (quel que soit le profil choisi : le compte peut avoir les droits d'administration).
    if (user.twoFactorEnabled) {
      return res.json({
        twoFactorRequired: true,
        challenge: twoFactor.signChallenge(user, { team: teamLogin }),
        message: "Saisissez le code de votre application d'authentification.",
      });
    }

    return res.json(session(user, { team: teamLogin }));

  } catch (err) {
    console.error("login", err);
    return res.status(500).json({ message: "Connexion impossible pour le moment. Réessayez." });
  }
};

// Jeton de session et profil renvoyés à l'app après une connexion réussie.
// `mfa` : le code de double authentification a été vérifié (exigé pour l'Espace ISD).
function session(user, { team = false, mfa = false } = {}) {
  const token = jwt.sign(
    { id: user._id, role: user.role, ...(mfa ? { mfa: true } : {}) },
    process.env.JWT_SECRET,
    { expiresIn: team ? TEAM_SESSION : SESSION }
  );
  return {
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
      isAdmin: !!user.isAdmin,
      twoFactorEnabled: !!user.twoFactorEnabled,
    },
  };
}
exports.session = session;

// ===============================
// LOGIN : ÉTAPE « CODE » (double authentification)
// ===============================
exports.loginTwoFactor = async (req, res) => {
  try {
    const challenge = twoFactor.readChallenge(req.body?.challenge);
    if (!challenge) {
      return res.status(401).json({ message: "Délai dépassé : reconnectez-vous avec votre mot de passe.", code: "CHALLENGE_EXPIRED" });
    }
    const user = await twoFactor.loadSecrets(challenge.id);
    if (!user) return res.status(401).json({ message: "Délai dépassé : reconnectez-vous avec votre mot de passe.", code: "CHALLENGE_EXPIRED" });

    const ip = req.ip || "inconnue";
    const wait = throttle.check(ip, user.email);
    if (wait) {
      res.set("Retry-After", String(wait));
      return res.status(429).json({ message: `Trop de codes faux. Réessayez dans ${Math.ceil(wait / 60)} min.` });
    }
    throttle.attempt(ip);

    const via = await twoFactor.checkCode(user, req.body?.code);
    if (!via) {
      throttle.failure(user.email);
      return res.status(401).json({ message: "Code incorrect ou déjà utilisé.", errors: { code: "Code incorrect ou déjà utilisé" } });
    }
    throttle.success(user.email);

    const full = await User.findById(user._id);
    const out = session(full, { team: challenge.team, mfa: true });
    if (via === "recovery") {
      const left = (user.twoFactor.recoveryCodes || []).length - 1;
      out.recoveryCodesLeft = left;
      out.message = `Connexion réussie avec un code de secours (il en reste ${left}).`;
    }
    return res.json(out);
  } catch (err) {
    console.error("login 2fa", err);
    return res.status(500).json({ message: "Connexion impossible pour le moment. Réessayez." });
  }
};
