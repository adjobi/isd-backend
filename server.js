const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");

// 🔥 Force le chargement du .env (ULTRA fiable)
dotenv.config({ path: path.resolve(__dirname, ".env") });

const authMiddleware = require("./middleware/authMiddleware");

const nannyRoutes = require("./routes/nannyRoutes");
const bookingRoutes = require("./routes/bookingRoutes");
const reviewRoutes = require("./routes/reviewRoutes");
const searchRoutes = require("./routes/searchRoutes");
const authRoutes = require("./routes/authRoutes");

const connectDB = require("./config/db");

// 🔥 DEBUG
console.log("MONGO_URI =", process.env.MONGO_URI);

// Connexion DB
connectDB();

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// ========================
// ROUTES API
// ========================
app.use("/api/auth", authRoutes);
app.use("/api/nannies", nannyRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/search", searchRoutes);

// ========================
// ROUTES TEST
// ========================
app.get("/", (req, res) => {
  res.send("ISD API is running 🚀");
});

app.get("/test", (req, res) => {
  res.json({ message: "Backend OK ✔️" });
});

// Route protégée
app.get("/api/profile", authMiddleware, (req, res) => {
  res.json({
    message: "Route protégée OK",
    user: req.user,
  });
});

// ========================
// LANCEMENT SERVEUR
// ========================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
