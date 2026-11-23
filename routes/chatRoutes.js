// Chat à trois : famille, prestataire et système ISD.
// Accès réservé aux deux participants de l'accord conclu en Phase 3.
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { ChatMessage, ChatSession } = require("../models/Chat");
const Offer = require("../models/Offer");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { containsChatContact } = require("../validators/contact");
const { encrypt } = require("../utils/crypto");
const chat = require("../services/chat");
const payment = require("../services/payment");

const MESSAGE_MAX = 1000;
const MAX_WARNINGS = 3;
const START_DATE_MAX_DAYS = 180;
const PUBLIC_USER_FIELDS = "firstName lastName photo role city commune availability";

router.param("offerId", (req, res, next, id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Identifiant invalide" });
  return next();
});

const serverError = (res, err) => {
  console.error("chat", err);
  return res.status(500).json({ message: "Erreur serveur. Réessayez dans un instant." });
};

// Charge la session et vérifie que l'utilisateur y participe.
// Si l'offre a été conclue avant l'existence du chat, la session est créée à la volée.
async function loadSession(req, res) {
  const { offerId } = req.params;
  let session = await ChatSession.findOne({ offerId });
  if (!session) {
    const offer = await Offer.findById(offerId);
    const accepted = offer?.applications?.find((a) => a.status === "accepted");
    const userId = String(req.user.id);
    if (offer && accepted && (chat.idOf(offer.family) === userId || chat.idOf(accepted.provider) === userId)) {
      session = await chat.openChat(offer, accepted.provider);
    }
  }
  const role = chat.participantRole(session, req.user.id);
  if (!session || !role) {
    res.status(404).json({ message: "Conversation introuvable" });
    return {};
  }
  return { session, role };
}

const ensureOpen = (session, res) => {
  if (session.status === "closed") {
    res.status(409).json({ message: "Ce chat est fermé." });
    return false;
  }
  return true;
};

// Notification « nouveau message » si le destinataire n'a pas le chat ouvert,
// et une seule non lue à la fois par conversation.
async function notifyRecipient(io, session, senderRole, preview) {
  const to = chat.otherRole(senderRole);
  if (await chat.isInRoom(io, session.offerId, to)) return;
  const userId = to === "family" ? session.familyId : session.providerId;
  const pending = await Notification.findOne({ userId, type: "chat_message", isRead: false, "metadata.offerId": session.offerId });
  if (pending) return;
  const who = senderRole === "family" ? "La famille" : "Votre prestataire";
  const text = preview.length > 80 ? `${preview.slice(0, 79)}…` : preview;
  await chat.notify(userId, "Nouveau message", `${who} : ${text}`, session.offerId);
}

// ================================
// MES CONVERSATIONS
// ================================
router.get("/", auth, async (req, res) => {
  try {
    const me = req.user.id;
    const sessions = await ChatSession.find({ $or: [{ familyId: me }, { providerId: me }] })
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .limit(50)
      .lean();
    const list = await Promise.all(sessions.map(async (s) => {
      const role = chat.participantRole(s, me);
      const otherId = role === "family" ? s.providerId : s.familyId;
      const [other, offer, last, unread] = await Promise.all([
        User.findById(otherId).select(PUBLIC_USER_FIELDS).lean(),
        Offer.findById(s.offerId).select("description serviceType agreedPrice city").lean(),
        ChatMessage.findOne(chat.visibleFilter(s.offerId, role)).sort({ createdAt: -1 }).lean(),
        ChatMessage.countDocuments({
          ...chat.visibleFilter(s.offerId, role),
          senderRole: { $ne: role },
          createdAt: { $gt: s.lastReadAt?.[role] || new Date(0) },
        }),
      ]);
      return {
        ...chat.publicSession(s),
        role,
        other,
        offer: offer ? { _id: offer._id, description: offer.description, serviceType: offer.serviceType, agreedPrice: offer.agreedPrice, city: offer.city } : null,
        lastMessage: last ? chat.publicMessage(last) : null,
        unread,
      };
    }));
    return res.json(list);
  } catch (err) {
    return serverError(res, err);
  }
});

// ================================
// UNE CONVERSATION : session + messages visibles
// ================================
router.get("/:offerId", auth, async (req, res) => {
  try {
    const { session, role } = await loadSession(req, res);
    if (!session) return undefined;
    const otherId = role === "family" ? session.providerId : session.familyId;
    const [messages, other, offer] = await Promise.all([
      ChatMessage.find(chat.visibleFilter(session.offerId, role)).sort({ createdAt: 1 }).limit(500).lean(),
      User.findById(otherId).select(PUBLIC_USER_FIELDS).lean(),
      Offer.findById(session.offerId).select("description serviceType agreedPrice city").lean(),
    ]);
    return res.json({
      session: chat.publicSession(session),
      role,
      other,
      offer,
      messages: messages.map(chat.publicMessage),
    });
  } catch (err) {
    return serverError(res, err);
  }
});

// ================================
// ENVOYER UN MESSAGE
// ================================
router.post("/:offerId/messages", auth, async (req, res) => {
  try {
    const raw = req.body?.text;
    if (typeof raw !== "string" || !raw.trim()) return res.status(400).json({ message: "Message vide" });
    const text = raw.trim();
    if (text.length > MESSAGE_MAX) return res.status(400).json({ message: `${MESSAGE_MAX} caractères maximum` });

    const { session, role } = await loadSession(req, res);
    if (!session) return undefined;
    if (!ensureOpen(session, res)) return undefined;
    const io = req.app.get("io");
    const base = { offerId: session.offerId, familyId: session.familyId, providerId: session.providerId };

    // Coordonnées : message bloqué (chiffré, visible du seul expéditeur), avertissement, fermeture à la 3e fois.
    // Après paiement de la facture, les coordonnées sont déjà échangées : plus de filtre.
    if (!session.isPaid && containsChatContact(text)) {
      if (!session.warnings) session.warnings = { family: 0, provider: 0 };
      const count = (session.warnings[role] || 0) + 1;
      session.warnings[role] = count;
      session.warningCount = (session.warningCount || 0) + 1;
      const created = [];
      created.push(await ChatMessage.create({
        ...base, senderRole: role, type: "blocked", isBlocked: true, visibleTo: role,
        message: "Message non transmis : il contenait des coordonnées.",
        originalEncrypted: encrypt(text),
      }));
      if (count < MAX_WARNINGS) {
        created.push(await chat.systemMessage(session, count === 1
          ? `Rappel ISD : téléphone, email, liens et réseaux sociaux sont interdits dans le chat. Ils seront échangés automatiquement après le paiement de la facture ISD. Votre message n'a pas été transmis. (Avertissement 1/${MAX_WARNINGS})`
          : `Dernier avertissement ISD : au prochain partage de coordonnées, ce chat sera fermé. (Avertissement ${count}/${MAX_WARNINGS})`,
        { type: "warning", visibleTo: role }));
      } else {
        session.status = "closed";
        session.closedReason = "contact_sharing";
        session.closedBy = "system";
        created.push(await chat.systemMessage(session,
          "Ce chat a été fermé par ISD : partage répété de coordonnées, contraire aux conditions d'utilisation. Contactez le support ISD si besoin.",
          { type: "warning" }));
        const otherId = role === "family" ? session.providerId : session.familyId;
        await chat.notify(otherId, "Chat fermé par ISD", "La conversation a été fermée suite au non-respect des règles. Contactez le support ISD si besoin.", session.offerId);
      }
      session.lastMessageAt = new Date();
      await session.save();
      created.forEach((m) => chat.emitMessage(io, m));
      if (session.status === "closed") chat.emitSession(io, session);
      return res.status(200).json({
        blocked: true,
        warnings: count,
        closed: session.status === "closed",
        messages: created.map(chat.publicMessage),
        session: chat.publicSession(session),
      });
    }

    const message = await ChatMessage.create({ ...base, senderRole: role, type: "text", message: text });
    session.lastMessageAt = message.createdAt || new Date();
    if (!session.lastReadAt) session.lastReadAt = {};
    session.lastReadAt[role] = session.lastMessageAt;
    await session.save();
    chat.emitMessage(io, message);
    await notifyRecipient(io, session, role, text);
    return res.status(201).json({ blocked: false, message: chat.publicMessage(message) });
  } catch (err) {
    return serverError(res, err);
  }
});

// ================================
// MESSAGES LUS
// ================================
router.post("/:offerId/read", auth, async (req, res) => {
  try {
    const { session, role } = await loadSession(req, res);
    if (!session) return undefined;
    const at = new Date();
    if (!session.lastReadAt) session.lastReadAt = {};
    session.lastReadAt[role] = at;
    await session.save();
    await Notification.updateMany(
      { userId: req.user.id, type: "chat_message", isRead: false, "metadata.offerId": session.offerId },
      { $set: { isRead: true } },
    );
    const io = req.app.get("io");
    if (io) io.to(chat.room(session.offerId, chat.otherRole(role))).emit("chat:read", { offerId: String(session.offerId), role, at });
    return res.json({ ok: true, at });
  } catch (err) {
    return serverError(res, err);
  }
});

// ================================
// DATE DE DÉBUT : une partie propose, l'autre accepte ou refuse
// ================================
function readStartDate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: "Date invalide (AAAA-MM-JJ)" };
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return { error: "Date invalide" };
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (d < today) return { error: "La date de début ne peut pas être passée" };
  const max = new Date(today.getTime() + START_DATE_MAX_DAYS * 86400000);
  if (d > max) return { error: "Date trop lointaine (6 mois maximum)" };
  return { value: d };
}

async function setCardStatus(io, messageId, status) {
  if (!messageId) return;
  const card = await ChatMessage.findByIdAndUpdate(messageId, { $set: { "meta.status": status } }, { new: true });
  if (card) chat.emitMessage(io, { ...(typeof card.toObject === "function" ? card.toObject() : card), _updated: true });
}

router.post("/:offerId/start-date", auth, async (req, res) => {
  try {
    const d = readStartDate(req.body?.date);
    if (d.error) return res.status(400).json({ message: d.error, errors: { date: d.error } });
    const { session, role } = await loadSession(req, res);
    if (!session) return undefined;
    if (!ensureOpen(session, res)) return undefined;
    if (session.startDate) return res.status(409).json({ message: "La date de début est déjà convenue." });
    const io = req.app.get("io");

    // Une proposition en cours (de l'une ou l'autre partie) est remplacée par la nouvelle.
    if (session.startDateProposal?.messageId) await setCardStatus(io, session.startDateProposal.messageId, "replaced");

    const card = await ChatMessage.create({
      offerId: session.offerId, familyId: session.familyId, providerId: session.providerId,
      senderRole: role, type: "start_date",
      message: `Proposition de date de début : ${chat.formatDay(d.value)}`,
      meta: { date: d.value, status: "pending" },
    });
    session.startDateProposal = { date: d.value, by: role, at: new Date(), messageId: card._id };
    session.lastMessageAt = new Date();
    await session.save();
    chat.emitMessage(io, card);
    chat.emitSession(io, session);
    await notifyRecipient(io, session, role, `propose de commencer le ${chat.formatDay(d.value)}`);
    return res.status(201).json({ message: chat.publicMessage(card), session: chat.publicSession(session) });
  } catch (err) {
    return serverError(res, err);
  }
});

router.post("/:offerId/start-date/respond", auth, async (req, res) => {
  try {
    const { accept } = req.body || {};
    if (typeof accept !== "boolean") return res.status(400).json({ message: "Réponse invalide" });
    const { session, role } = await loadSession(req, res);
    if (!session) return undefined;
    if (!ensureOpen(session, res)) return undefined;
    const proposal = session.startDateProposal;
    if (!proposal?.date) return res.status(409).json({ message: "Aucune date proposée." });
    if (proposal.by === role) return res.status(403).json({ message: "C'est à l'autre partie de répondre à votre proposition." });
    const io = req.app.get("io");
    const proposerId = proposal.by === "family" ? session.familyId : session.providerId;
    const day = chat.formatDay(proposal.date);

    await setCardStatus(io, proposal.messageId, accept ? "accepted" : "declined");
    let sys;
    if (accept) {
      session.startDate = proposal.date;
      session.status = "agreement_reached";
      sys = await chat.systemMessage(session,
        `📅 Date de début convenue : ${day}.\n\nProchaine étape : le règlement de la facture ISD par la famille. Vos coordonnées et le récapitulatif de vos engagements seront alors disponibles automatiquement.`,
        { meta: { kind: "start_date_confirmed", date: proposal.date } });
      await chat.notify(proposerId, "Date de début confirmée 📅", `Le démarrage est fixé au ${day}.`, session.offerId);
    } else {
      sys = await chat.systemMessage(session, `La date du ${day} n'a pas été retenue. Proposez une autre date quand vous serez prêts.`);
      await chat.notify(proposerId, "Date de début refusée", `La date du ${day} n'a pas été retenue. Proposez-en une autre dans le chat.`, session.offerId);
    }
    session.startDateProposal = { date: null, by: null, at: null, messageId: null };
    session.lastMessageAt = new Date();
    await session.save();
    chat.emitMessage(io, sys);
    chat.emitSession(io, session);
    // Date convenue : la facture ISD est émise (offerte s'il s'agit d'un remplacement garanti).
    if (accept) {
      try {
        await payment.ensureInvoice(session, io);
      } catch (err) {
        console.error("facture", err);
      }
    }
    return res.json({ message: chat.publicMessage(sys), session: chat.publicSession(session) });
  } catch (err) {
    return serverError(res, err);
  }
});

// ================================
// PAIEMENT : désactivé jusqu'à la Phase 5 (vérification réelle du paiement Mobile Money)
// ================================
router.post("/confirm-payment/:offerId", auth, (req, res) =>
  res.status(503).json({ message: "Le paiement Mobile Money arrive bientôt." }));

module.exports = router;
