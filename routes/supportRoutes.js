// Aide et contact :
//   GET  /api/public/contact    → moyens de contacter ISD (WhatsApp, email) : monté dans publicRoutes
//   POST /api/support           { topic, message } → demande à l'équipe ISD (5 par heure au plus)
//   GET  /api/support           → mes demandes et les réponses de l'équipe
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const SupportRequest = require("../models/SupportRequest");
const User = require("../models/User");
const Notification = require("../models/Notification");

const TOPICS = ["payment", "mission", "account", "other"];
const TOPIC_LABELS = { payment: "Paiement", mission: "Mission", account: "Mon compte", other: "Autre question" };
const MAX_PER_HOUR = 5;

// Coordonnées publiques d'ISD (réglées sur le serveur : WHATSAPP_ISD, CONTACT_EMAIL).
function contactInfo() {
  const wa = String(process.env.WHATSAPP_ISD || "").replace(/\D/g, "");
  const whatsapp = /^225\d{10}$/.test(wa) ? wa : null;
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.CONTACT_EMAIL || "") ? process.env.CONTACT_EMAIL.trim() : null;
  return {
    whatsapp,
    whatsappDisplay: whatsapp ? `+225 ${whatsapp.slice(3).replace(/(\d{2})(?=\d)/g, "$1 ")}` : null,
    email,
  };
}

function readRequest(body) {
  const errors = {};
  const topic = TOPICS.includes(body?.topic) ? body.topic : null;
  if (!topic) errors.topic = "Choisissez le sujet de votre demande";
  const message = typeof body?.message === "string" ? body.message.trim().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n") : "";
  if (message.length < 10) errors.message = "Décrivez votre demande (10 caractères minimum)";
  else if (message.length > 1000) errors.message = "1000 caractères maximum";
  return Object.keys(errors).length ? { errors } : { topic, message };
}

const serialize = (r) => ({
  id: String(r._id), topic: r.topic, topicLabel: TOPIC_LABELS[r.topic], message: r.message, status: r.status,
  reply: r.reply?.text ? { text: r.reply.text, at: r.reply.at } : null, createdAt: r.createdAt,
});

router.post("/", auth, async (req, res) => {
  try {
    const input = readRequest(req.body);
    if (input.errors) return res.status(400).json({ message: "Merci de corriger les champs en surbrillance", errors: input.errors });
    const recent = await SupportRequest.countDocuments({ user: req.user.id, createdAt: { $gte: new Date(Date.now() - 3600 * 1000) } });
    if (recent >= MAX_PER_HOUR) {
      return res.status(429).json({ message: "Vous avez déjà envoyé plusieurs demandes. L'équipe vous répond au plus vite ; pour une urgence, écrivez-nous sur WhatsApp." });
    }
    const user = await User.findById(req.user.id).select("role firstName").lean();
    if (!user) return res.status(401).json({ message: "Session expirée : reconnectez-vous." });
    const doc = await SupportRequest.create({ user: req.user.id, role: user.role, ...input });

    // Prévenir l'équipe ISD (notification dans l'app).
    const admins = await User.find({ isAdmin: true }).select("_id").lean();
    await Promise.all(admins.filter((a) => String(a._id) !== String(req.user.id)).map((a) => Notification.create({
      userId: a._id, type: "system_alert", title: "Nouvelle demande d'aide",
      message: `${TOPIC_LABELS[input.topic]} : ${input.message.slice(0, 120)}`, metadata: { support: String(doc._id), admin: true },
    }).catch(() => {})));

    return res.status(201).json({ message: "Demande envoyée. L'équipe ISD vous répond ici et dans vos notifications.", request: serialize(doc) });
  } catch (err) {
    console.error("POST /support", err);
    return res.status(500).json({ message: "Envoi impossible pour le moment. Réessayez ou écrivez-nous sur WhatsApp." });
  }
});

router.get("/", auth, async (req, res) => {
  try {
    const list = await SupportRequest.find({ user: req.user.id }).sort({ createdAt: -1 }).limit(20).lean();
    return res.json({ requests: list.map(serialize) });
  } catch (err) {
    console.error("GET /support", err);
    return res.status(500).json({ message: "Impossible de charger vos demandes. Réessayez." });
  }
});

module.exports = router;
module.exports.contactInfo = contactInfo;
module.exports.TOPIC_LABELS = TOPIC_LABELS;
