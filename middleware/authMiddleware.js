const jwt = require("jsonwebtoken");
const { touchUser } = require("../services/audience");

module.exports = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ message: "Token manquant" });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({ message: "Token invalide" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded;
    touchUser(decoded); // activité du jour (rétention), une écriture par compte et par jour

    next();
  } catch (error) {
    return res.status(401).json({ message: "Session expirée : reconnectez-vous." });
  }
};
