const express = require("express");

// La photo de profil (300 Ko max, ~400 Ko en base64) dépasse la limite par défaut de 100 Ko.
// On relève la limite uniquement pour PUT /api/auth/profile.
const PROFILE_BODY_LIMIT = "450kb";
// Vérification d'identité : deux photos de 300 Ko max (~800 Ko en base64). Ce parseur n'est PAS monté
// ici : routes/identityRoutes.js l'applique à POST /api/identity après authentification, rôle et
// limiteur, pour qu'aucun corps ne soit lu pour un visiteur anonyme.
const IDENTITY_BODY_LIMIT = "900kb";
const identityJson = express.json({ limit: IDENTITY_BODY_LIMIT });

// /api/identity et ses sous-chemins (insensible à la casse, comme le routage Express).
const isIdentityPath = (path) => /^\/api\/identity(\/|$)/i.test(path || "");

const jsonParsers = (app) => {
  app.use("/api/auth/profile", express.json({ limit: PROFILE_BODY_LIMIT }));
  const defaultJson = express.json();
  app.use((req, res, next) => (isIdentityPath(req.path) ? next() : defaultJson(req, res, next)));
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

module.exports = { jsonParsers, bodyErrorHandler, identityJson, isIdentityPath, PROFILE_BODY_LIMIT, IDENTITY_BODY_LIMIT };
