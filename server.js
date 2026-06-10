const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const http = require("http");
const { Server } = require("socket.io");

dotenv.config();

const connectDB = require("./config/db");

// =====================
// ROUTES
// =====================
const authRoutes = require("./routes/authRoutes");
const bookingRoutes = require("./routes/bookingRoutes");
const nannyRoutes = require("./routes/nannyRoutes");
const offerRoutes = require("./routes/offerRoutes");
const chatRoutes = require("./routes/chatRoutes");

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

// =====================
// MIDDLEWARES
// =====================
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"]
}));

app.use(express.json());

// =====================
// HTTP SERVER
// =====================
const server = http.createServer(app);

// =====================
// SOCKET.IO
// =====================
const io = new Server(server, {
  cors: {
    origin: "*",
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
app.use("/api/bookings", bookingRoutes);
app.use("/api/nannies", nannyRoutes);
app.use("/api/offers", offerRoutes);
if (notificationRoutes) {
  app.use("/api/notifications", notificationRoutes);
}
app.use("/api/chat", chatRoutes);

// =====================
// TEST ROUTES
// =====================
app.get("/", (req, res) => {
  res.send("ISD Real-Time API 🚀");
});

// DEBUG SOCKET USERS
app.get("/api/debug/online-users", (req, res) => {
  res.json({
    onlineUsers: Array.from(onlineUsers.entries()),
  });
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
