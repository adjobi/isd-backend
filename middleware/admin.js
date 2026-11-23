// Réservé aux administrateurs ISD (droit relu en base à chaque requête, jamais pris du jeton).
const User = require("../models/User");

module.exports = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select("isAdmin").lean();
    if (!user?.isAdmin) return res.status(403).json({ message: "Accès réservé à l'équipe ISD." });
    return next();
  } catch (err) {
    console.error("admin", err);
    return res.status(500).json({ message: "Erreur serveur. Réessayez dans un instant." });
  }
};
