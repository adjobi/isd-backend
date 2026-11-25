const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const http = require("http");
const { Server } = require("socket.io");

dotenv.config();

// Configuration vérifiée avant tout : en production, on refuse de démarrer si elle est dangereuse.
const { checkEnv, corsOrigins, isProd } = require("./config/env");
const envProblems = checkEnv();
if (envProblems.length) {
  envProblems.forEach((p) => console.error("❌ Configuration :", p));
  if (isProd()) process.exit(1);
}

const connectDB = require("./config/db");
const { jsonParsers, bodyErrorHandler } = require("./middleware/bodyParsing");

// =====================
// ROUTES
// =====================
const authRoutes = require("./routes/authRoutes");
const bookingRoutes = require("./routes/bookingRoutes");
const nannyRoutes = require("./routes/nannyRoutes");
const offerRoutes = require("./routes/offerRoutes");
const chatRoutes = require("./routes/chatRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const actionRoutes = require("./routes/actionRoutes");
const publicRoutes = require("./routes/publicRoutes");
const adminRoutes = require("./routes/adminRoutes");

// (OPTIONNEL MAIS RECOMMANDÉ)
let notificationRoutes;
try {
  notificationRoutes = require("./routes/notificationRoutes");
} catch (e) {
  console.log("⚠️ notificationRoutes not found");
}

// =====================
// SOCKET
// =====================
const initSocket = require("./socket/socketManager");

// =====================
// DB
// =====================
connectDB();

const app = express();
app.disable("x-powered-by");
// Derrière le proxy HTTPS (Caddy) : l'adresse IP réelle du visiteur sert aux limites de tentatives.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

// =====================
// MIDDLEWARES
// =====================
const allowedOrigins = corsOrigins();
app.use(cors({
  origin: allowedOrigins,
  methods: ["GET", "POST", "PUT", "DELETE"]
}));

jsonParsers(app);

// =====================
// HTTP SERVER
// =====================
const server = http.createServer(app);

// =====================
// SOCKET.IO
// =====================
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
  },
});

// SAFE INIT SOCKET
let onlineUsers = new Map();

try {
  onlineUsers = initSocket(io);
} catch (err) {
  console.log("⚠️ Socket init failed:", err.message);
}

// GLOBALS
app.set("io", io);
app.set("onlineUsers", onlineUsers);

// =====================
// ROUTES
// =====================
app.use("/api/auth", authRoutes);
app.use("/api/auth", require("./routes/twoFactorRoutes"));
app.use("/api/bookings", bookingRoutes);
app.use("/api/nannies", nannyRoutes);
app.use("/api/offers", offerRoutes);
if (notificationRoutes) {
  app.use("/api/notifications", notificationRoutes);
}
app.use("/api/chat", chatRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/actions", actionRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/admin", adminRoutes);

// =====================
// TEST ROUTES
// =====================
app.get("/", (req, res) => {
  res.send("ISD Real-Time API 🚀");
});

// Santé du service (surveillance, redémarrage automatique) : API et base joignables.
app.get("/api/health", (req, res) => {
  const dbUp = require("mongoose").connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({ status: dbUp ? "ok" : "base indisponible" });
});

app.use(bodyErrorHandler);

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
