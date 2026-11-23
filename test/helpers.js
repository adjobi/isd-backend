const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "secret-de-test";

const tokenFor = (id, role) => jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: "1h" });

// Application minimale montant uniquement les routes testées (pas de DB, pas de socket).
const buildApp = () => {
  const app = express();
  const { jsonParsers, bodyErrorHandler } = require("../middleware/bodyParsing");
  jsonParsers(app);
  app.use("/api/auth", require("../routes/authRoutes"));
  app.use("/api/nannies", require("../routes/nannyRoutes"));
  app.use("/api/offers", require("../routes/offerRoutes"));
  app.use(bodyErrorHandler);
  return app;
};

// Imite la chaîne Mongoose find().select().sort().skip().limit().lean()
const chain = (result, calls) => {
  const q = {};
  ["select", "sort", "skip", "limit", "populate"].forEach((m) => {
    q[m] = (arg) => { calls[m] = arg; return q; };
  });
  q.lean = async () => result;
  return q;
};

module.exports = { tokenFor, buildApp, chain };
