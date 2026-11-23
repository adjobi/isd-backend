const express = require("express");

// La photo de profil (300 Ko max, ~400 Ko en base64) dépasse la limite par défaut de 100 Ko.
// On relève la limite uniquement pour PUT /api/auth/profile.
const PROFILE_BODY_LIMIT = "450kb";

const jsonParsers = (app) => {
  app.use("/api/auth/profile", express.json({ limit: PROFILE_BODY_LIMIT }));
  app.use(express.json());
};

// Erreurs de lecture du corps → JSON en français (au lieu d'une page HTML).
// eslint-disable-next-line no-unused-vars
const bodyErrorHandler = (err, req, res, next) => {
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ message: "Données trop volumineuses (photo trop lourde ?)" });
  }
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Requête mal formée" });
  }
  console.error(err);
  return res.status(500).json({ message: "Erreur serveur. Réessayez." });
};

module.exports = { jsonParsers, bodyErrorHandler, PROFILE_BODY_LIMIT };
