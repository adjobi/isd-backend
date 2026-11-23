// Réservé aux administrateurs ISD (droit relu en base à chaque requête, jamais pris du jeton).
// Session d'administration courte : un jeton de plus de 12 h ne donne plus accès à l'Espace ISD,
// même s'il reste valide pour le reste de l'app (on redemande le mot de passe).
const User = require("../models/User");

const ADMIN_SESSION_SECONDS = 12 * 60 * 60;

module.exports = async (req, res, next) => {
  try {
    const age = Math.floor(Date.now() / 1000) - (req.user?.iat || 0);
    if (age > ADMIN_SESSION_SECONDS) {
      return res.status(401).json({ message: "Session d'administration expirée : reconnectez-vous." });
    }
    const user = await User.findById(req.user.id).select("isAdmin").lean();
    if (!user?.isAdmin) return res.status(403).json({ message: "Accès réservé à l'équipe ISD." });
    return next();
  } catch (err) {
    console.error("admin", err);
    return res.status(500).json({ message: "Erreur serveur. Réessayez dans un instant." });
  }
};

module.exports.ADMIN_SESSION_SECONDS = ADMIN_SESSION_SECONDS;
