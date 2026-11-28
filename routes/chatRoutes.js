// Chat à trois : famille, prestataire et système ISD.
// Une discussion (ChatSession) par couple (offre, prestataire), ouverte par « Discuter » ;
// accès réservé à la famille propriétaire et au prestataire de CETTE discussion.
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { ChatMessage, ChatSession } = require("../models/Chat");
const Offer = require("../models/Offer");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { containsChatContact, messageDigits, phoneAcrossMessages, hasContactIntent } = require("../validators/contact");
const { recordContactStrike } = require("../services/moderation");
const { maskName } = require("../utils/names");
const { encrypt } = require("../utils/crypto");
const chat = require("../services/chat");
const payment = require("../services/payment");
const apps = require("../services/applications");

const MESSAGE_MAX = 1000;
const MAX_WARNINGS = 3;
// Mémoire des chiffres entre messages : 5 derniers messages de la même partie, sur 15 minutes.
const MEMORY_MESSAGES = 5;
const MEMORY_MS = 15 * 60 * 1000;
const chatLimiter = require("../middleware/rateLimit")({
  windowMs: 60 * 1000, max: 30, key: (req) => req.user?.id,
  message: "Vous envoyez beaucoup de messages : patientez une minute.",
});
const REMINDER = "Petit rappel ISD : le téléphone, l'email et les réseaux sociaux s'échangent automatiquement après le paiement de la facture ISD. Merci de ne pas les écrire ici.";
const START_DATE_MAX_DAYS = 180;
const PUBLIC_USER_FIELDS = "firstName lastName photo role city commune availability";

for (const name of ["offerId", "sessionId"]) {
  router.param(name, (req, res, next, id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Identifiant invalide" });
    return next();
  });
}

const serverError = (res, err) => {
  console.error("chat", err);
  return res.status(500).json({ message: "Erreur serveur. Réessayez dans un instant." });
};
const isProviderRole = (role) => role === "nanny" || role === "tutor";

// Ancienne adresse /api/chat/:offerId : retrouve la discussion de l'utilisateur pour cette offre.
// Prestataire : la sienne. Famille : ?providerId=…, sinon celle de l'accord conclu.
// Une offre conclue avant l'existence du chat voit sa discussion créée à la volée.
async function sessionByOffer(req) {
  const { offerId } = req.params;
  const userId = String(req.user.id);
  const asked = req.query?.providerId;
  let providerId = null;
  let offer = null;
  if (isProviderRole(req.user.role)) providerId = userId;
  else if (typeof asked === "string" && mongoose.Types.ObjectId.isValid(asked)) providerId = asked;
  else {
    offer = await Offer.findById(offerId);
    providerId = chat.idOf(offer?.acceptedProvider) || chat.idOf(offer?.applications?.find((a) => a.status === "accepted")?.provider) || null;
  }
  if (!providerId) return null;
  const session = await chat.findSession(offerId, providerId);
  if (session) return session;
  offer = offer || await Offer.findById(offerId);
  const app = offer?.applications?.find((a) => chat.idOf(a.provider) === String(providerId));
  if (!offer || !app || (chat.idOf(offer.family) !== userId && chat.idOf(app.provider) !== userId)) return null;
  const stage = apps.stageOf(app);
  if (stage === "accepted") return chat.openChat(offer, app.provider);
  if (apps.ACTIVE_STAGES.includes(stage)) return chat.openSession(offer, app.provider);
  return null;
}

// Charge la session (par son identifiant, ou par offre) et vérifie que l'utilisateur y participe.
// Un autre candidat, une autre famille ou un compte extérieur : 404 (on ne confirme pas l'existence).
async function loadSession(req, res) {
  const session = req.params.sessionId ? await ChatSession.findById(req.params.sessionId) : await sessionByOffer(req);
  const role = chat.participantRole(session, req.user.id);
  if (!session || !role) {
    res.status(404).json({ message: "Conversation introuvable" });
    return {};
  }
  return { session, role };
}

// Discussion fermée par ISD pour partage de coordonnées : la candidature (si encore en cours)
// est refusée, et ne compte plus dans les discussions actives.
async function closeApplicationForContactSharing(io, session) {
  try {
    const offer = await Offer.findById(session.offerId);
    const app = offer?.applications?.find((a) => chat.idOf(a.provider) === chat.idOf(session.providerId));
    if (!app || !apps.isOpen(app)) return;
    apps.closeApplication(app, "rejected", "contact_sharing");
    if (offer.targetProvider) offer.status = "closed";
    await offer.save();
    chat.emitApplication(io, session, apps.serializeApplication(app));
  } catch (err) {
    console.error("candidature après fermeture du chat", err);
  }
}

// Fragments de chiffres récents d'une partie (mémoire entre messages).
function recentFragments(session, role, now = Date.now()) {
  const list = session.contactMemory?.[role];
  return (Array.isArray(list) ? list : []).filter((f) => f && now - new Date(f.at).getTime() < MEMORY_MS).slice(-(MEMORY_MESSAGES - 1));
}
function setFragments(session, role, list) {
  const mem = { family: [], provider: [], ...(session.contactMemory || {}) };
  mem[role] = list;
  session.contactMemory = mem;
  if (typeof session.markModified === "function") session.markModified("contactMemory");
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
  if (await chat.isInRoom(io, session._id, to)) return;
  const userId = to === "family" ? session.familyId : session.providerId;
  const pending = await Notification.findOne({ userId, type: "chat_message", isRead: false, "metadata.sessionId": chat.idOf(session._id) });
  if (pending) return;
  const who = senderRole === "family" ? "La famille" : session.status === "discussion" ? "Le prestataire" : "Votre prestataire";
  const text = preview.length > 80 ? `${preview.slice(0, 79)}…` : preview;
  await chat.notify(userId, "Nouveau message", `${who} : ${text}`, session.offerId, session._id);
}

// Offre telle que vue dans une discussion : le salaire convenu n'apparaît que dans la
// discussion de l'accord (jamais celui d'un concurrent).
function offerView(offer, session) {
  if (!offer) return null;
  const mine = chat.idOf(offer.acceptedProvider) === chat.idOf(session.providerId);
  return {
    _id: offer._id, description: offer.description, serviceType: offer.serviceType, city: offer.city,
    duration: offer.duration, subjects: offer.subjects || [], price: offer.price || 0,
    status: offer.status, isDirectOffer: !!offer.targetProvider,
    agreedPrice: mine ? offer.agreedPrice ?? null : null,
    agreedUnit: mine ? offer.agreedUnit || null : null,
  };
}
const applicationOf = (offer, session) => {
  const app = (offer?.applications || []).find((a) => chat.idOf(a.provider) === chat.idOf(session.providerId));
  return app ? apps.serializeApplication(app) : null;
};
const OFFER_FIELDS = "description serviceType agreedPrice agreedUnit acceptedProvider city duration subjects price status targetProvider family applications";

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
      const hide = (u) => (s.isPaid ? u : maskName(u));
      const [other, offer, last, unread] = await Promise.all([
        User.findById(otherId).select(PUBLIC_USER_FIELDS).lean(),
        Offer.findById(s.offerId).select(OFFER_FIELDS).lean(),
        ChatMessage.findOne(chat.visibleFilter(s, role)).sort({ createdAt: -1 }).lean(),
        ChatMessage.countDocuments({
          ...chat.visibleFilter(s, role),
          senderRole: { $ne: role },
          createdAt: { $gt: s.lastReadAt?.[role] || new Date(0) },
        }),
      ]);
      return {
        ...chat.publicSession(s),
        role,
        other: hide(other),
        offer: offerView(offer, s),
        application: applicationOf(offer, s),
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
router.get(["/sessions/:sessionId", "/:offerId"], auth, async (req, res) => {
  try {
    const { session, role } = await loadSession(req, res);
    if (!session) return undefined;
    const otherId = role === "family" ? session.providerId : session.familyId;
    const [messages, other, offer] = await Promise.all([
      ChatMessage.find(chat.visibleFilter(session, role)).sort({ createdAt: 1 }).limit(500).lean(),
      User.findById(otherId).select(role === "family" ? `${PUBLIC_USER_FIELDS} pricingType pricingAmount` : PUBLIC_USER_FIELDS).lean(),
      Offer.findById(session.offerId).select(OFFER_FIELDS).lean(),
    ]);
    return res.json({
      session: chat.publicSession(session),
      role,
      // Avant paiement : prénom et initiale du nom seulement
      other: session.isPaid ? other : maskName(other),
      offer: offerView(offer, session),
      application: applicationOf(offer, session),
      messages: messages.map(chat.publicMessage),
    });
  } catch (err) {
    return serverError(res, err);
  }
});

// ================================
// ENVOYER UN MESSAGE
// ================================
router.post(["/sessions/:sessionId/messages", "/:offerId/messages"], auth, chatLimiter, async (req, res) => {
  try {
    const raw = req.body?.text;
    if (typeof raw !== "string" || !raw.trim()) return res.status(400).json({ message: "Message vide" });
    const text = raw.trim();
    if (text.length > MESSAGE_MAX) return res.status(400).json({ message: `${MESSAGE_MAX} caractères maximum` });

    const { session, role } = await loadSession(req, res);
    if (!session) return undefined;
    if (!ensureOpen(session, res)) return undefined;
    const io = req.app.get("io");
    const base = { sessionId: session._id, offerId: session.offerId, familyId: session.familyId, providerId: session.providerId };

    // Coordonnées : message bloqué (chiffré, visible du seul expéditeur), avertissement, fermeture à la 3e fois.
    // Après paiement de la facture, les coordonnées sont déjà échangées : plus de filtre.
    // Un numéro dicté en plusieurs messages (chiffres ou lettres) est aussi bloqué.
    const fragment = session.isPaid ? "" : messageDigits(text);
    const previous = session.isPaid ? [] : recentFragments(session, role);
    const across = !!fragment && phoneAcrossMessages([...previous.map((f) => f.d), fragment]);
    if (!session.isPaid && (across || containsChatContact(text))) {
      setFragments(session, role, []);
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
        await closeApplicationForContactSharing(io, session);
        await chat.notify(otherId, "Chat fermé par ISD", "La conversation a été fermée suite au non-respect des règles. Contactez le support ISD si besoin.", session.offerId, session._id);
      }
      session.lastMessageAt = new Date();
      await session.save();
      await recordContactStrike(req.user.id, "chat");
      created.forEach((m) => chat.emitMessage(io, m, session));
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
    if (fragment) setFragments(session, role, [...previous, { d: fragment.slice(-12), at: new Date() }]);
    // Intention sans coordonnée (« mon numéro… », « appelle-moi ») : rappel discret, une fois, non compté.
    let reminder = null;
    if (!session.isPaid && !session.contactReminded?.[role] && hasContactIntent(text)) {
      reminder = await chat.systemMessage(session, REMINDER, { type: "warning", visibleTo: role, meta: { kind: "contact_reminder" } });
      if (!session.contactReminded) session.contactReminded = { family: false, provider: false };
      session.contactReminded[role] = true;
    }
    await session.save();
    chat.emitMessage(io, message, session);
    if (reminder) chat.emitMessage(io, reminder, session);
    await notifyRecipient(io, session, role, text);
    return res.status(201).json({ blocked: false, message: chat.publicMessage(message), reminder: reminder ? chat.publicMessage(reminder) : null });
  } catch (err) {
    return serverError(res, err);
  }
});

// ================================
// MESSAGES LUS
// ================================
router.post(["/sessions/:sessionId/read", "/:offerId/read"], auth, async (req, res) => {
  try {
    const { session, role } = await loadSession(req, res);
    if (!session) return undefined;
    const at = new Date();
    if (!session.lastReadAt) session.lastReadAt = {};
    session.lastReadAt[role] = at;
    await session.save();
    // Notifications de cette discussion (et anciennes notifications sans sessionId de l'offre).
    await Notification.updateMany(
      {
        userId: req.user.id, type: "chat_message", isRead: false,
        $or: [
          { "metadata.sessionId": chat.idOf(session._id) },
          { "metadata.offerId": session.offerId, "metadata.sessionId": { $exists: false } },
        ],
      },
      { $set: { isRead: true } },
    );
    const io = req.app.get("io");
    if (io) io.to(chat.room(chat.idOf(session._id), chat.otherRole(role))).emit("chat:read", { offerId: String(session.offerId), sessionId: chat.idOf(session._id), role, at });
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

async function setCardStatus(io, session, messageId, status) {
  if (!messageId) return;
  const card = await ChatMessage.findByIdAndUpdate(messageId, { $set: { "meta.status": status } }, { new: true });
  if (card) chat.emitMessage(io, { ...(typeof card.toObject === "function" ? card.toObject() : card), _updated: true }, session);
}

// La date de début se convient dans la discussion de l'accord conclu, pas avant.
const ensureAgreement = (session, res) => {
  if (session.status === "discussion") {
    res.status(409).json({ message: "La date de début se convient une fois le salaire accepté." });
    return false;
  }
  return true;
};

router.post(["/sessions/:sessionId/start-date", "/:offerId/start-date"], auth, async (req, res) => {
  try {
    const d = readStartDate(req.body?.date);
    if (d.error) return res.status(400).json({ message: d.error, errors: { date: d.error } });
    const { session, role } = await loadSession(req, res);
    if (!session) return undefined;
    if (!ensureOpen(session, res)) return undefined;
    if (!ensureAgreement(session, res)) return undefined;
    if (session.startDate) return res.status(409).json({ message: "La date de début est déjà convenue." });
    const io = req.app.get("io");

    // Une proposition en cours (de l'une ou l'autre partie) est remplacée par la nouvelle.
    if (session.startDateProposal?.messageId) await setCardStatus(io, session, session.startDateProposal.messageId, "replaced");

    const card = await ChatMessage.create({
      sessionId: session._id, offerId: session.offerId, familyId: session.familyId, providerId: session.providerId,
      senderRole: role, type: "start_date",
      message: `Proposition de date de début : ${chat.formatDay(d.value)}`,
      meta: { date: d.value, status: "pending" },
    });
    session.startDateProposal = { date: d.value, by: role, at: new Date(), messageId: card._id };
    session.lastMessageAt = new Date();
    await session.save();
    chat.emitMessage(io, card, session);
    chat.emitSession(io, session);
    await notifyRecipient(io, session, role, `propose de commencer le ${chat.formatDay(d.value)}`);
    return res.status(201).json({ message: chat.publicMessage(card), session: chat.publicSession(session) });
  } catch (err) {
    return serverError(res, err);
  }
});

router.post(["/sessions/:sessionId/start-date/respond", "/:offerId/start-date/respond"], auth, async (req, res) => {
  try {
    const { accept } = req.body || {};
    if (typeof accept !== "boolean") return res.status(400).json({ message: "Réponse invalide" });
    const { session, role } = await loadSession(req, res);
    if (!session) return undefined;
    if (!ensureOpen(session, res)) return undefined;
    if (!ensureAgreement(session, res)) return undefined;
    const proposal = session.startDateProposal;
    if (!proposal?.date) return res.status(409).json({ message: "Aucune date proposée." });
    if (proposal.by === role) return res.status(403).json({ message: "C'est à l'autre partie de répondre à votre proposition." });
    const io = req.app.get("io");
    const proposerId = proposal.by === "family" ? session.familyId : session.providerId;
    const day = chat.formatDay(proposal.date);

    await setCardStatus(io, session, proposal.messageId, accept ? "accepted" : "declined");
    let sys;
    if (accept) {
      session.startDate = proposal.date;
      session.status = "agreement_reached";
      sys = await chat.systemMessage(session,
        `📅 Date de début convenue : ${day}.\n\nProchaine étape : le règlement de la facture ISD par la famille. Vos coordonnées et le récapitulatif de vos engagements seront alors disponibles automatiquement.`,
        { meta: { kind: "start_date_confirmed", date: proposal.date } });
      await chat.notify(proposerId, "Date de début confirmée 📅", `Le démarrage est fixé au ${day}.`, session.offerId, session._id);
    } else {
      sys = await chat.systemMessage(session, `La date du ${day} n'a pas été retenue. Proposez une autre date quand vous serez prêts.`);
      await chat.notify(proposerId, "Date de début refusée", `La date du ${day} n'a pas été retenue. Proposez-en une autre dans le chat.`, session.offerId, session._id);
    }
    session.startDateProposal = { date: null, by: null, at: null, messageId: null };
    session.lastMessageAt = new Date();
    await session.save();
    chat.emitMessage(io, sys, session);
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
module.exports.chatLimiter = chatLimiter;
