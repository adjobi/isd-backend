const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB connecté");
    // Discussions par (offre, prestataire) : prévient si l'ancien index unique est encore là.
    require("../services/chatIndexes").warnIfLegacy().catch(() => {});
  } catch (error) {
    console.error("❌ Erreur MongoDB:", error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
