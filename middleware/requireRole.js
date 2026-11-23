// Restreint une route à un ou plusieurs rôles (à placer après authMiddleware).
module.exports = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: "Accès non autorisé pour ce profil" });
  }
  next();
};
