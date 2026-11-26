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
const TOO_MANY = "Vous avez déjà envoyé plusieurs demandes. L'équipe vous répond au plus vite ; pour une urgence, écrivez-nous sur WhatsApp.";

// Garde-fou par adresse IP contre les comptes multiples. Beaucoup d'abonnés mobiles partagent
// la même IP (NAT des opérateurs) : seuil large, et seuls comptent les envois valides de comptes
// connectés encore sous leur limite (un anonyme ne peut pas bloquer l'aide pour les autres).
const supportLimiter = require("../middleware/rateLimit")({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Trop de demandes envoyées depuis cette connexion. Réessayez dans un quart d'heure ou écrivez-nous sur WhatsApp.",
});

// Texte saisi : fins de ligne Windows/anciens Mac → \n, espaces multiples réduits, 2 lignes vides au plus.
const cleanText = (v) => (typeof v === "string"
  ? v.replace(/\r\n?/g, "\n").trim().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n")
  : "");

// Coordonnées publiques d'ISD (réglées sur le serveur : WHATSAPP_ISD, CONTACT_EMAIL).
function contactInfo() {
  const wa = String(process.env.WHATSAPP_ISD || "").replace(/\D/g, "");
  const whatsapp = /^225\d{10}$/.test(wa) ? wa : null;
  const mail = String(process.env.CONTACT_EMAIL || "").trim();
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) ? mail : null;
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
  const message = cleanText(body?.message);
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
    const lastHour = () => ({ user: req.user.id, createdAt: { $gte: new Date(Date.now() - 3600 * 1000) } });
    if (await SupportRequest.countDocuments(lastHour()) >= MAX_PER_HOUR) return res.status(429).json({ message: TOO_MANY });
    const wait = supportLimiter.hit(req);
    if (wait) {
      res.set("Retry-After", String(wait));
      return res.status(429).json({ message: supportLimiter.message });
    }
    const user = await User.findById(req.user.id).select("role firstName").lean();
    if (!user) return res.status(401).json({ message: "Session expirée : reconnectez-vous." });
    const doc = await SupportRequest.create({ user: req.user.id, role: user.role, ...input });

    // Requêtes simultanées : chacune recompte APRÈS son enregistrement et s'annule si la limite est dépassée.
    // La dernière enregistrée voit toutes les autres : jamais plus de MAX_PER_HOUR demandes conservées.
    if (await SupportRequest.countDocuments(lastHour()) > MAX_PER_HOUR) {
      await SupportRequest.deleteOne({ _id: doc._id });
      return res.status(429).json({ message: TOO_MANY });
    }

    res.status(201).json({ message: "Demande envoyée. L'équipe ISD vous répond ici et dans vos notifications.", request: serialize(doc) });

    // Prévenir l'équipe ISD après la réponse : texte générique, jamais le contenu du message.
    notifyAdmins(doc, req.user.id).catch((e) => console.error("notification demande d'aide", e.message));
    return undefined;
  } catch (err) {
    console.error("POST /support", err);
    if (res.headersSent) return undefined;
    return res.status(500).json({ message: "Envoi impossible pour le moment. Réessayez ou écrivez-nous sur WhatsApp." });
  }
});

async function notifyAdmins(doc, authorId) {
  const admins = await User.find({ isAdmin: true }).select("_id").lean();
  const notes = admins.filter((a) => String(a._id) !== String(authorId)).map((a) => ({
    userId: a._id, type: "system_alert", title: "Nouvelle demande d'aide",
    message: `Nouvelle demande d'aide : ${TOPIC_LABELS[doc.topic]}`, metadata: { support: String(doc._id), admin: true },
  }));
  if (notes.length) await Notification.insertMany(notes, { ordered: false });
}

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
module.exports.cleanText = cleanText;
module.exports.supportLimiter = supportLimiter;
