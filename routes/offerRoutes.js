const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const Offer = require("../models/Offer");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { ChatMessage } = require("../models/Chat");
const { PUBLIC_PROVIDER_FIELDS } = require("../controllers/nannyController");
const { validateOffer, readAmount, readMessage, hasContactError, MAX_COUNTERS, CONTACT_MESSAGE } = require("../validators/offer");
const chat = require("../services/chat");
const apps = require("../services/applications");
const { recordContactStrike } = require("../services/moderation");
const { maskName } = require("../utils/names");
const rateLimit = require("../middleware/rateLimit");

// Champs d'une famille visibles par les prestataires : jamais de téléphone ni d'email.
const PUBLIC_FAMILY_FIELDS = "firstName lastName city commune photo";
const PROVIDER_FIELDS = Array.isArray(PUBLIC_PROVIDER_FIELDS) ? PUBLIC_PROVIDER_FIELDS.join(" ") : PUBLIC_PROVIDER_FIELDS;

// ================================
// OUTILS
// ================================
const isProviderRole = (role) => role === "nanny" || role === "tutor";
const idOf = (v) => (v && v._id ? v._id : v)?.toString();
const actorOf = (req) => (req.user.role === "family" ? "family" : isProviderRole(req.user.role) ? "provider" : null);
const ROLE_NAME = { family: "La famille", provider: "Le prestataire" };

// Identifiants d'URL validés une fois pour toutes (400 au lieu d'une erreur serveur).
for (const name of ["id", "offerId", "providerId"]) {
  router.param(name, (req, res, next, value) => {
    if (!mongoose.isValidObjectId(value)) return res.status(400).json({ message: "Identifiant invalide" });
    return next();
  });
}

// Limites par compte (anti-abus). Comptées après authentification.
const byUser = (req) => req.user?.id;
const offerWriteLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, key: byUser, message: "Trop d'offres créées ou modifiées en peu de temps. Réessayez dans une heure." });
const directOfferLimiter = rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 10, key: byUser, message: "Vous avez envoyé beaucoup de propositions directes aujourd'hui. Réessayez demain." });
const applyLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, key: byUser, message: "Trop de candidatures en peu de temps. Réessayez dans une heure." });
const tooMany = (res, limiter, wait) => {
  res.set("Retry-After", String(wait));
  return res.status(429).json({ message: limiter.message });
};

const familyOnly = (req, res) => {
  if (req.user.role !== "family") { res.status(403).json({ message: "Réservé aux familles" }); return false; }
  return true;
};
const providerOnly = (req, res) => {
  if (!isProviderRole(req.user.role)) { res.status(403).json({ message: "Réservé aux prestataires" }); return false; }
  return true;
};

// Erreurs : jamais de détail technique côté client.
function fail(res, err, where) {
  if (err && err.name === "VersionError") {
    return res.status(409).json({ message: "Cette offre vient d’être modifiée. Rechargez puis réessayez." });
  }
  if (err && err.name === "LegacyIndexError") {
    console.error(where, err.message);
    return res.status(503).json({ message: "La messagerie est en cours de mise à jour. Réessayez dans un instant." });
  }
  console.error(where, err);
  return res.status(500).json({ message: "Une erreur est survenue. Réessayez." });
}

// Une notification qui échoue ne doit pas faire échouer l'action.
async function notify(userId, title, message, type, offerId, sessionId = null) {
  try {
    const metadata = sessionId ? { offerId, sessionId: idOf(sessionId) } : { offerId };
    await Notification.create({ userId, title, message, type, metadata });
  } catch (err) {
    console.error("notification", err);
  }
}

const formatPrice = (n) => `${Number(n).toLocaleString("fr-FR")} FCFA`;

// Accord conclu ET facture ISD réglée pour ce prestataire : le nom complet peut être montré.
const paidFor = (o, providerId) => !!o.paidAt && !!o.acceptedProvider && idOf(o.acceptedProvider) === String(providerId);

// Vue prestataire : sa propre candidature uniquement (ni les concurrents, ni leurs prix).
// Nom de la famille réduit à l'initiale avant paiement.
function serializeForProvider(offer, userId) {
  const o = typeof offer.toObject === "function" ? offer.toObject() : { ...offer };
  const mine = (o.applications || []).find((a) => idOf(a.provider) === userId);
  const { applications, acceptedProvider, ...rest } = o;
  const isMine = idOf(acceptedProvider) === userId;
  return {
    ...rest,
    family: paidFor(o, userId) ? o.family : maskName(o.family),
    agreedPrice: isMine ? o.agreedPrice : null,
    agreedUnit: isMine ? o.agreedUnit || null : null,
    isDirectOffer: !!o.targetProvider,
    applicantsCount: (applications || []).length,
    myApplication: mine ? apps.serializeApplication(mine) : null,
  };
}

function serializeForFamily(offer) {
  const o = typeof offer.toObject === "function" ? offer.toObject() : { ...offer };
  return {
    ...o,
    // Nom des prestataires réduit à l'initiale, sauf celui de l'accord payé
    applications: (o.applications || []).map((a) => {
      const s = apps.serializeApplication(a);
      return paidFor(o, idOf(a.provider)) ? s : { ...s, provider: maskName(s.provider) };
    }),
    activeDiscussions: apps.activeCount(o),
    maxDiscussions: apps.MAX_ACTIVE_DISCUSSIONS,
  };
}

// Unité du tarif du prestataire (mois par défaut), pour l'affichage des cartes de prix.
async function unitOf(providerId) {
  try {
    const u = await User.findById(providerId).select("pricingType").lean();
    return u?.pricingType || "month";
  } catch {
    return "month";
  }
}

// Offre + candidature du couple (offre, prestataire), avec contrôle d'accès :
// la famille propriétaire, ou le prestataire lui-même. Jamais un autre prestataire.
async function loadApplication(req, res, { offerId, providerId, roles = ["family", "provider"] }) {
  const actor = actorOf(req);
  if (!actor || !roles.includes(actor)) { res.status(403).json({ message: "Non autorisé" }); return {}; }
  const offer = await Offer.findById(offerId);
  if (!offer) { res.status(404).json({ message: "Offre introuvable" }); return {}; }
  if (actor === "family" && idOf(offer.family) !== req.user.id) { res.status(403).json({ message: "Non autorisé" }); return {}; }
  if (actor === "provider" && providerId !== req.user.id) { res.status(403).json({ message: "Non autorisé" }); return {}; }
  const app = offer.applications.find((a) => idOf(a.provider) === providerId);
  if (!app) { res.status(404).json({ message: "Candidature introuvable" }); return {}; }
  return { actor, offer, app };
}

// Discussion d'une candidature ; recréée si son ouverture avait échoué.
async function sessionOf(offer, app, status = "discussion") {
  const found = await chat.findSession(offer._id, app.provider);
  if (found) return found;
  return chat.openSession(offer, app.provider, status === "discussion" ? { status } : { status, welcome: chat.WELCOME });
}

// Met à jour le statut d'une carte de prix déjà affichée (remplacée, acceptée).
async function setPriceCard(io, session, messageId, status) {
  if (!messageId) return;
  try {
    const card = await ChatMessage.findByIdAndUpdate(messageId, { $set: { "meta.status": status } }, { new: true });
    if (card) chat.emitMessage(io, { ...(typeof card.toObject === "function" ? card.toObject() : card), _updated: true }, session);
  } catch (err) {
    console.error("carte de prix", err);
  }
}

const closeApplication = apps.closeApplication;

// Discussion fermée (ex. par ISD pour partage de coordonnées) : plus aucune action de négociation.
async function ensureSessionOpen(res, offer, app) {
  const session = await chat.findSession(offer._id, app.provider);
  if (session && session.status === "closed") {
    res.status(409).json({ message: "Ce chat est fermé." });
    return false;
  }
  return true;
}

// Discussions en cours d'une famille, toutes offres ouvertes confondues.
async function familyActiveDiscussions(familyId) {
  const offers = await Offer.find({ family: familyId, status: "open", "applications.stage": { $in: apps.ACTIVE_STAGES } })
    .select("applications").lean();
  return (offers || []).reduce((n, o) => n + (o.applications || []).filter(apps.isActive).length, 0);
}
const FAMILY_CAP = { message: `Vous avez déjà ${apps.MAX_FAMILY_DISCUSSIONS} discussions en cours (toutes offres confondues) : terminez-en une avant d'en ouvrir une nouvelle.` };

// Textes de fermeture des discussions (neutres et chaleureux).
const CLOSE_TEXT = {
  other_chosen: "La famille a choisi un autre prestataire pour cette offre. Merci pour cet échange ! D'autres offres vous attendent.",
  rejected: "Cette discussion est terminée : la famille a choisi de ne pas poursuivre pour cette mission. Merci pour cet échange ! D'autres offres vous attendent.",
  withdrawn: "Cette discussion est terminée : le prestataire s'est retiré. Merci pour cet échange !",
  declined: "Cette discussion est terminée : le prestataire a décliné la proposition. Merci pour cet échange !",
  offer_closed: "La famille a fermé cette offre : cette discussion est terminée. Merci pour cet échange ! D'autres offres vous attendent.",
};

// Ferme la discussion d'une candidature, si elle existe (sans faire échouer l'action).
async function closeDiscussion(io, offer, app, reason, by) {
  try {
    const session = await chat.findSession(offer._id, app.provider);
    if (session) await chat.closeSession(io, session, { reason, by, text: CLOSE_TEXT[reason] });
  } catch (err) {
    console.error("fermeture de discussion", err);
  }
}

// Conclut l'accord : candidature acceptée au prix sur la table, les autres refusées
// et leurs discussions fermées poliment.
// Un accord porte toujours sur un prix : sans lui, ni frais ISD justes ni contrat complet.
const agreedPriceOf = (offer, app) => app.proposedPrice || offer.price || null;
const NO_PRICE = { message: "Aucun salaire n'est encore proposé : faites d'abord une proposition." };

async function conclude(offer, app, acceptedBy, io) {
  const providerId = idOf(app.provider);
  // Unité figée à l'accord : celle de la proposition acceptée (sinon le tarif du prestataire).
  const lastOffer = (app.history || [])[(app.history || []).length - 1];
  const unit = lastOffer?.unit || await unitOf(providerId);
  const others = [];
  for (const a of offer.applications) {
    if (a === app) {
      a.status = "accepted";
      a.stage = "accepted";
    } else if (apps.isOpen(a)) {
      others.push({ provider: idOf(a.provider), hadDiscussion: apps.isActive(a), app: a, sessionId: a.sessionId || null });
      closeApplication(a, "rejected", "other_chosen");
    }
  }
  offer.status = "closed";
  offer.acceptedProvider = app.provider;
  offer.agreedPrice = agreedPriceOf(offer, app);
  offer.agreedUnit = unit;
  offer.acceptedAt = new Date();
  await offer.save();

  // Discussion de l'accord : passe à l'état « active » (date de début, facture, paiement…).
  // Un échec ne remet pas l'accord en cause : la discussion sera rouverte à la première visite.
  let session = null;
  try {
    session = await sessionOf(offer, app, "active");
    if (session.status === "discussion") {
      session.status = "active";
      session.lastMessageAt = new Date();
      await session.save();
    }
    await setPriceCard(io, session, app.priceCardId, "accepted");
    const msg = await chat.systemMessage(session,
      `🤝 Accord conclu : salaire de ${chat.priceLabel(offer.agreedPrice, unit)}, accepté par ${acceptedBy === "family" ? "la famille" : "le prestataire"}.\n\nProchaine étape : convenez d'une date de début avec le bouton « Date » en haut de l'écran. Les coordonnées seront échangées automatiquement après le paiement de la facture ISD par la famille.`,
      { type: "price_accepted", meta: { kind: "price_accepted", amount: offer.agreedPrice, unit, by: acceptedBy } });
    chat.emitMessage(io, msg, session);
    chat.emitSession(io, session);
    chat.emitApplication(io, session, apps.serializeApplication(app));
  } catch (err) {
    console.error("ouverture du chat", err);
  }

  const sid = session?._id || app.sessionId;
  const price = offer.agreedPrice ? ` à ${formatPrice(offer.agreedPrice)}` : "";
  if (acceptedBy === "family") {
    await notify(providerId, "Candidature acceptée 🎉", `La famille a accepté votre candidature${price}. La suite se passe dans le chat ISD.`, "booking_accepted", offer._id, sid);
  } else {
    await notify(offer.family, "Proposition acceptée 🎉", `Le prestataire a accepté votre proposition${price}. La suite se passe dans le chat ISD.`, "booking_accepted", offer._id, sid);
  }
  for (const o of others) {
    if (o.hadDiscussion) await closeDiscussion(io, offer, o.app, "other_chosen", "system");
    await notify(o.provider, "Candidature non retenue", "La famille a choisi un autre prestataire pour cette offre. D’autres offres vous attendent !", "booking_rejected", offer._id, o.hadDiscussion ? o.sessionId : null);
  }
}

// Ferme une offre : les candidatures en cours sont refusées ; renvoie l'envoi des avis
// et la fermeture des discussions ouvertes.
function closePending(offer, reason, io) {
  const closed = [];
  for (const a of offer.applications) {
    if (apps.isOpen(a)) {
      closed.push({ provider: idOf(a.provider), hadDiscussion: apps.isActive(a), app: a });
      closeApplication(a, "rejected", "offer_closed");
    }
  }
  return async () => {
    for (const c of closed) {
      if (c.hadDiscussion) await closeDiscussion(io, offer, c.app, "offer_closed", "family");
      await notify(c.provider, "Offre fermée", reason, "booking_rejected", offer._id);
    }
  };
}

// ================================
// CRÉER UNE OFFRE (famille)
// Avec targetProvider : proposition directe à un prestataire précis ; la discussion s'ouvre
// directement (étape « discussion ») et le prix indiqué reste un budget indicatif.
// ================================
router.post("/", auth, offerWriteLimiter, async (req, res) => {
  try {
    if (!familyOnly(req, res)) return undefined;
    const { data, errors } = validateOffer(req.body);
    if (hasContactError(errors)) await recordContactStrike(req.user.id, "offer");
    const { targetProvider } = req.body || {};
    let provider = null;
    if (targetProvider !== undefined && targetProvider !== null && targetProvider !== "") {
      const wait = directOfferLimiter.hit(req);
      if (wait) return tooMany(res, directOfferLimiter, wait);
      if (!mongoose.isValidObjectId(targetProvider)) errors.targetProvider = "Prestataire invalide";
      else {
        provider = await User.findById(targetProvider).select("role availability pricingAmount").lean();
        if (!provider || !isProviderRole(provider.role)) errors.targetProvider = "Prestataire introuvable";
        else if (data.serviceType && provider.role !== data.serviceType) errors.targetProvider = "Ce prestataire ne propose pas ce service";
        else if (["away", "holiday"].includes(provider.availability)) {
          return res.status(409).json({ message: "Ce prestataire est indisponible pour le moment (congé ou vacances)." });
        }
      }
    }
    if (Object.keys(errors).length) {
      return res.status(400).json({ message: "Merci de corriger les champs en surbrillance", errors });
    }

    // Proposition directe = discussion ouverte : plafond par famille.
    if (provider && await familyActiveDiscussions(req.user.id) >= apps.MAX_FAMILY_DISCUSSIONS) return res.status(409).json(FAMILY_CAP);

    const offerData = { ...data, family: req.user.id };
    let sessionId = null;
    if (provider) {
      sessionId = new mongoose.Types.ObjectId();
      offerData.targetProvider = provider._id;
      offerData.price = data.price || provider.pricingAmount || 0; // budget indicatif
      offerData.applications = [{
        provider: provider._id, status: "pending", stage: "discussion", sessionId, discussionAt: new Date(),
        missionAgreed: { family: null, provider: null }, proposedPrice: null, lastOfferBy: null, history: [],
      }];
    }
    const offer = await Offer.create(offerData);
    if (provider) {
      try {
        const session = await chat.openSession(offer, provider._id, { sessionId });
        sessionId = session._id;
      } catch (err) {
        // La discussion sera rouverte à la première action (sessionOf) ou visite du chat.
        console.error("ouverture de la discussion directe", err);
      }
      const budget = offerData.price ? ` (budget indicatif : ${formatPrice(offerData.price)})` : "";
      await notify(provider._id, "Nouvelle proposition directe", `Une famille souhaite discuter avec vous d'une mission${budget}. Ouvrez la discussion pour en parler.`, "booking_request", offer._id, sessionId);
    }
    return res.status(201).json({ message: "Offre créée", offer, sessionId });
  } catch (err) {
    return fail(res, err, "POST /offers");
  }
});

// ================================
// MES OFFRES (famille)
// ================================
router.get("/my", auth, async (req, res) => {
  try {
    if (!familyOnly(req, res)) return undefined;
    const offers = await Offer.find({ family: req.user.id })
      .populate("applications.provider", PROVIDER_FIELDS)
      .sort({ createdAt: -1 });
    return res.json(offers.map(serializeForFamily));
  } catch (err) {
    return fail(res, err, "GET /offers/my");
  }
});

// ================================
// OFFRES DISPONIBLES (prestataires)
// Offres publiques ouvertes du bon type + propositions directes qui me ciblent.
// ================================
router.get("/available", auth, async (req, res) => {
  try {
    if (!providerOnly(req, res)) return undefined;
    const offers = await Offer.find({
      serviceType: req.user.role,
      status: "open",
      $or: [{ targetProvider: null }, { targetProvider: req.user.id }],
    })
      .populate("family", PUBLIC_FAMILY_FIELDS)
      .sort({ createdAt: -1 });
    return res.json(offers.map((o) => serializeForProvider(o, req.user.id)));
  } catch (err) {
    return fail(res, err, "GET /offers/available");
  }
});

// ================================
// MES CANDIDATURES (prestataire) — toutes, quel que soit le statut
// ================================
router.get("/my-applications", auth, async (req, res) => {
  try {
    if (!providerOnly(req, res)) return undefined;
    const offers = await Offer.find({ "applications.provider": req.user.id })
      .populate("family", PUBLIC_FAMILY_FIELDS)
      .sort({ updatedAt: -1 });
    return res.json(offers.map((o) => serializeForProvider(o, req.user.id)));
  } catch (err) {
    return fail(res, err, "GET /offers/my-applications");
  }
});

// ================================
// MODIFIER UNE OFFRE (famille) — tant qu'aucun accord n'est conclu
// ================================
router.put("/:id", auth, offerWriteLimiter, async (req, res) => {
  try {
    if (!familyOnly(req, res)) return undefined;
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (idOf(offer.family) !== req.user.id) return res.status(403).json({ message: "Non autorisé" });
    if (offer.status === "closed") return res.status(400).json({ message: "Impossible de modifier une offre fermée" });
    if (offer.targetProvider) return res.status(400).json({ message: "Une proposition directe se discute avec le prestataire dans la discussion" });
    const { data, errors } = validateOffer(req.body, { partial: true, serviceType: offer.serviceType });
    if (hasContactError(errors)) await recordContactStrike(req.user.id, "offer");
    if (Object.keys(errors).length) {
      return res.status(400).json({ message: "Merci de corriger les champs en surbrillance", errors });
    }
    Object.assign(offer, data);
    await offer.save();
    return res.json({ message: "Offre modifiée", offer });
  } catch (err) {
    return fail(res, err, "PUT /offers/:id");
  }
});

// ================================
// FERMER UNE OFFRE (famille)
// ================================
router.put("/:id/cancel", auth, async (req, res) => {
  try {
    if (!familyOnly(req, res)) return undefined;
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (idOf(offer.family) !== req.user.id) return res.status(403).json({ message: "Non autorisé" });
    if (offer.status === "closed") return res.status(400).json({ message: "Cette offre est déjà fermée" });
    const sendNotices = closePending(offer, "La famille a fermé cette offre.", req.app.get("io"));
    offer.status = "closed";
    await offer.save();
    await sendNotices();
    return res.json({ message: "Offre fermée" });
  } catch (err) {
    return fail(res, err, "PUT /offers/:id/cancel");
  }
});

// ================================
// SUPPRIMER UNE OFFRE (famille) — impossible après un accord (base de la facture)
// ================================
router.delete("/:id", auth, async (req, res) => {
  try {
    if (!familyOnly(req, res)) return undefined;
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (idOf(offer.family) !== req.user.id) return res.status(403).json({ message: "Non autorisé" });
    if (offer.acceptedProvider || offer.applications.some((a) => a.status === "accepted")) {
      return res.status(400).json({ message: "Un accord a été conclu sur cette offre : elle ne peut plus être supprimée." });
    }
    const sendNotices = closePending(offer, "La famille a retiré cette offre.", req.app.get("io"));
    await offer.deleteOne();
    await sendNotices();
    return res.json({ message: "Offre supprimée" });
  } catch (err) {
    return fail(res, err, "DELETE /offers/:id");
  }
});

// ================================
// CANDIDATER À UNE OFFRE PUBLIQUE (prestataire)
// body : { message? } — pas de prix : le salaire se convient plus tard, dans la discussion.
// ================================
router.post("/:id/apply", auth, applyLimiter, async (req, res) => {
  try {
    if (!providerOnly(req, res)) return undefined;
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (offer.status !== "open") return res.status(400).json({ message: "Cette offre est fermée" });
    if (offer.serviceType && offer.serviceType !== req.user.role) {
      return res.status(403).json({ message: "Cette offre concerne un autre type de prestataire" });
    }
    if (offer.targetProvider) {
      return res.status(400).json({ message: "Proposition directe : répondez à la famille dans la discussion." });
    }
    const previous = offer.applications.find((a) => idOf(a.provider) === req.user.id);
    if (previous) {
      return res.status(400).json({ message: apps.stageOf(previous) === "withdrawn" ? "Vous vous êtes retiré de cette offre : vous ne pouvez plus y candidater." : "Vous avez déjà candidaté" });
    }
    const msg = readMessage((req.body || {}).message);
    if (msg.error === CONTACT_MESSAGE) await recordContactStrike(req.user.id, "application");
    if (msg.error) return res.status(400).json({ message: msg.error, errors: { message: msg.error } });

    offer.applications.push({
      provider: req.user.id, status: "pending", stage: "applied", message: msg.value,
      missionAgreed: { family: null, provider: null }, proposedPrice: null, lastOfferBy: null, history: [],
    });
    await offer.save();
    await notify(offer.family, "Nouvelle candidature", "Un prestataire souhaite réaliser votre mission. Consultez son profil puis choisissez « Discuter » ou « Refuser ».", "booking_request", offer._id);
    return res.status(201).json({ message: "Candidature envoyée", offer: serializeForProvider(offer, req.user.id) });
  } catch (err) {
    return fail(res, err, "POST /offers/:id/apply");
  }
});

// ================================
// DISCUTER AVEC UN CANDIDAT (famille) : ouvre la discussion privée
// 3 discussions actives au maximum par offre.
// ================================
router.post("/:offerId/applications/:providerId/discuss", auth, async (req, res) => {
  try {
    const { offer, app } = await loadApplication(req, res, { ...req.params, roles: ["family"] });
    if (!offer) return undefined;
    if (offer.status !== "open") return res.status(400).json({ message: "Cette offre est fermée" });
    const stage = apps.stageOf(app);
    if (apps.ACTIVE_STAGES.includes(stage)) {
      const existing = await sessionOf(offer, app);
      return res.json({ message: "La discussion est déjà ouverte", application: apps.serializeApplication(app), sessionId: existing._id });
    }
    if (stage !== "applied") return res.status(400).json({ message: "Cette candidature a déjà été traitée" });
    if (apps.activeCount(offer) >= apps.MAX_ACTIVE_DISCUSSIONS) {
      return res.status(409).json({ message: `Vous discutez déjà avec ${apps.MAX_ACTIVE_DISCUSSIONS} prestataires : terminez une discussion pour en ouvrir une autre.` });
    }
    if (await familyActiveDiscussions(req.user.id) >= apps.MAX_FAMILY_DISCUSSIONS) return res.status(409).json(FAMILY_CAP);

    const sessionId = new mongoose.Types.ObjectId();
    app.stage = "discussion";
    app.discussionAt = new Date();
    app.sessionId = sessionId;
    app.missionAgreed = { family: null, provider: null };
    await offer.save();
    let session;
    try {
      session = await chat.openSession(offer, app.provider, { sessionId });
    } catch (err) {
      // Discussion impossible à ouvrir : la candidature revient à l'étape précédente.
      app.stage = "applied";
      app.discussionAt = null;
      app.sessionId = null;
      await offer.save().catch((e) => console.error("retour à l'étape candidature", e));
      throw err;
    }
    if (idOf(session._id) !== idOf(sessionId)) {
      app.sessionId = session._id;
      await offer.save();
    }

    await notify(app.provider, "La famille souhaite discuter avec vous 💬", "Parlez ensemble de la mission dans la discussion ISD.", "chat_message", offer._id, session._id);
    return res.status(201).json({
      message: "Discussion ouverte", application: apps.serializeApplication(app), sessionId: session._id,
      activeDiscussions: apps.activeCount(offer), maxDiscussions: apps.MAX_ACTIVE_DISCUSSIONS,
    });
  } catch (err) {
    return fail(res, err, "POST /offers/:offerId/applications/:providerId/discuss");
  }
});

// ================================
// « JE SUIS D'ACCORD SUR LA MISSION » (famille ou prestataire) — étape discussion
// body : { agree: true | false } ; false retire son accord tant que l'autre n'a pas confirmé.
// Les deux d'accord : étape salaire.
// ================================
router.post("/:offerId/applications/:providerId/mission-agreement", auth, async (req, res) => {
  try {
    const { agree } = req.body || {};
    if (typeof agree !== "boolean") return res.status(400).json({ message: "Réponse invalide", errors: { agree: "Réponse invalide" } });
    const { actor, offer, app } = await loadApplication(req, res, req.params);
    if (!offer) return undefined;
    if (offer.status !== "open") return res.status(400).json({ message: "Cette offre est fermée" });
    const stage = apps.stageOf(app);
    if (stage === "salary") {
      return res.status(409).json({ message: "La mission est déjà validée par les deux parties : vous pouvez convenir du salaire." });
    }
    if (stage !== "discussion") {
      return res.status(409).json({ message: stage === "applied" ? "La discussion n'est pas encore ouverte." : "Cette candidature a déjà été traitée" });
    }
    if (!(await ensureSessionOpen(res, offer, app))) return undefined;
    if (!app.missionAgreed) app.missionAgreed = { family: null, provider: null };
    const other = apps.otherRole(actor);
    const mine = !!app.missionAgreed[actor];
    if (agree === mine) {
      return res.json({ message: agree ? "Accord déjà enregistré" : "Aucun accord à retirer", application: apps.serializeApplication(app) });
    }
    // Anti-abus : pas de bascule en rafale, et un nombre limité de changements par candidature.
    const now = new Date();
    const last = app.missionLastToggle?.[actor];
    if (last && now - new Date(last) < apps.MISSION_TOGGLE_MIN_MS) {
      const wait = Math.ceil((apps.MISSION_TOGGLE_MIN_MS - (now - new Date(last))) / 1000);
      res.set("Retry-After", String(Math.max(1, wait)));
      return res.status(429).json({ message: "Patientez quelques secondes avant de modifier à nouveau votre accord." });
    }
    if ((app.missionToggles || 0) >= apps.MAX_MISSION_TOGGLES) {
      return res.status(409).json({ message: "Votre accord sur la mission a été modifié trop souvent. Continuez d'en parler dans la discussion, ou contactez le support ISD." });
    }
    app.missionToggles = (app.missionToggles || 0) + 1;
    if (!app.missionLastToggle) app.missionLastToggle = { family: null, provider: null };
    app.missionLastToggle[actor] = now;
    app.missionAgreed[actor] = agree ? now : null;
    const both = !!(app.missionAgreed.family && app.missionAgreed.provider);
    if (both) app.stage = "salary";
    await offer.save();

    const io = req.app.get("io");
    const session = await sessionOf(offer, app);
    let msg;
    if (both) {
      msg = await chat.systemMessage(session,
        "✅ Mission validée par la famille et par le prestataire : vous pouvez maintenant convenir du salaire.",
        { type: "mission_agreed", meta: { kind: "mission_agreed", family: app.missionAgreed.family, provider: app.missionAgreed.provider } });
    } else if (agree) {
      msg = await chat.systemMessage(session,
        `${ROLE_NAME[actor]} est d'accord sur la mission ✅. ${actor === "family" ? "Au prestataire" : "À la famille"} de confirmer quand la mission lui convient.`,
        { meta: { kind: "mission_agree", by: actor } });
    } else {
      msg = await chat.systemMessage(session,
        `${ROLE_NAME[actor]} a retiré son accord sur la mission : continuez d'en parler ensemble.`,
        { meta: { kind: "mission_agree_withdrawn", by: actor } });
    }
    session.lastMessageAt = new Date();
    await session.save();
    const serialized = apps.serializeApplication(app);
    chat.emitMessage(io, msg, session);
    chat.emitApplication(io, session, serialized);
    if (agree) {
      const target = other === "family" ? offer.family : app.provider;
      await chat.notify(target,
        both ? "Mission validée ✅" : "Accord sur la mission",
        both ? "Vous êtes d'accord sur la mission : place à la discussion du salaire." : `${ROLE_NAME[actor]} est d'accord sur la mission. À vous de confirmer dans la discussion.`,
        offer._id, session._id);
    }
    return res.json({ message: both ? "Mission validée : place au salaire" : agree ? "Accord enregistré" : "Accord retiré", application: serialized });
  } catch (err) {
    return fail(res, err, "POST /offers/:offerId/applications/:providerId/mission-agreement");
  }
});

// ================================
// PROPOSER / CONTRE-PROPOSER UN SALAIRE (famille propriétaire OU prestataire concerné)
// Étape salaire uniquement. Première proposition par l'un ou l'autre, puis chacun son tour,
// 3 contre-propositions maximum par partie.
// ================================
router.post("/:offerId/applications/:providerId/counter", auth, async (req, res) => {
  try {
    const { actor, offer, app } = await loadApplication(req, res, req.params);
    if (!offer) return undefined;
    if (offer.status !== "open") return res.status(400).json({ message: "Cette offre est fermée" });
    const stage = apps.stageOf(app);
    if (!apps.OPEN_STAGES.includes(stage)) return res.status(400).json({ message: "Cette candidature a déjà été traitée" });
    if (stage !== "salary") {
      return res.status(409).json({ message: "Le salaire se discute une fois la mission validée par les deux parties." });
    }
    if (!(await ensureSessionOpen(res, offer, app))) return undefined;
    const turn = apps.turnOf(app);
    if (turn !== "either" && turn !== actor) return res.status(409).json({ message: "C’est à l’autre partie de répondre à votre dernière proposition." });
    if (apps.countersUsed(app, actor) >= MAX_COUNTERS) {
      return res.status(409).json({ message: `Vous avez utilisé vos ${MAX_COUNTERS} contre-propositions : acceptez ou refusez le dernier prix.` });
    }
    const a = readAmount((req.body || {}).amount);
    if (a.error) return res.status(400).json({ message: a.error, errors: { amount: a.error } });
    if (turn !== "either" && a.value === app.proposedPrice) return res.status(400).json({ message: "Ce prix est déjà sur la table : acceptez-le plutôt." });

    const io = req.app.get("io");
    const unit = await unitOf(app.provider);
    const previousCard = app.priceCardId;
    const cardId = new mongoose.Types.ObjectId();
    app.history.push({ by: actor, amount: a.value, unit });
    app.proposedPrice = a.value;
    app.lastOfferBy = actor;
    app.priceCardId = cardId;
    await offer.save();

    const session = await sessionOf(offer, app);
    await setPriceCard(io, session, previousCard, "replaced");
    const first = app.history.length === 1;
    const card = await ChatMessage.create({
      _id: cardId, sessionId: session._id, offerId: offer._id, familyId: session.familyId, providerId: session.providerId,
      senderRole: actor, type: "price_offer",
      message: `💰 ${first ? "Proposition" : "Contre-proposition"} de salaire ${actor === "family" ? "de la famille" : "du prestataire"} : ${chat.priceLabel(a.value, unit)}.`,
      meta: { kind: "price_offer", amount: a.value, unit, by: actor, status: "pending", round: app.history.length },
    });
    session.lastMessageAt = new Date();
    await session.save();
    const serialized = apps.serializeApplication(app);
    chat.emitMessage(io, card, session);
    chat.emitApplication(io, session, serialized);

    const target = actor === "family" ? app.provider : offer.family;
    await notify(
      target, first ? "Proposition de salaire" : "Contre-proposition",
      actor === "family" ? `La famille vous propose ${formatPrice(a.value)}.` : `Le prestataire vous propose ${formatPrice(a.value)}.`,
      "offer_counter", offer._id, session._id
    );
    return res.json({ message: "Proposition envoyée", application: serialized, card: chat.publicMessage(card) });
  } catch (err) {
    return fail(res, err, "POST /offers/:offerId/applications/:providerId/counter");
  }
});

// ================================
// ACCEPTER LE SALAIRE SUR LA TABLE (famille ou prestataire, quand c'est son tour)
// L'accord est conclu ; les autres candidatures en cours sont refusées et leurs discussions fermées.
// ================================
async function acceptPrice(req, res, providerId, roles, where) {
  try {
    const { actor, offer, app } = await loadApplication(req, res, { offerId: req.params.offerId || req.params.id, providerId, roles });
    if (!offer) return undefined;
    if (offer.status !== "open") return res.status(400).json({ message: "Cette offre est fermée" });
    const stage = apps.stageOf(app);
    if (!apps.OPEN_STAGES.includes(stage)) return res.status(404).json({ message: "Candidature introuvable ou déjà traitée" });
    if (stage !== "salary") return res.status(409).json({ message: "Le salaire se discute une fois la mission validée par les deux parties." });
    if (!(await ensureSessionOpen(res, offer, app))) return undefined;
    const turn = apps.turnOf(app);
    if (turn === "either" || !agreedPriceOf(offer, app)) return res.status(409).json(NO_PRICE);
    if (turn !== actor) {
      return res.status(409).json({ message: actor === "family" ? "Votre dernière proposition attend la réponse du prestataire." : "Votre proposition attend la réponse de la famille." });
    }
    await conclude(offer, app, actor, req.app.get("io"));
    return res.json({
      message: actor === "family" ? "Candidature acceptée" : "Proposition acceptée",
      offer: actor === "family" ? serializeForFamily(offer) : serializeForProvider(offer, req.user.id),
      application: apps.serializeApplication(app),
    });
  } catch (err) {
    return fail(res, err, where);
  }
}

router.post("/:offerId/applications/:providerId/accept", auth, (req, res) =>
  acceptPrice(req, res, req.params.providerId, ["family", "provider"], "POST /offers/:offerId/applications/:providerId/accept"));
// Anciennes routes, conservées : famille / prestataire.
router.post("/:offerId/accept/:providerId", auth, (req, res) => {
  if (!familyOnly(req, res)) return undefined;
  return acceptPrice(req, res, req.params.providerId, ["family"], "POST /offers/:offerId/accept/:providerId");
});
router.post("/:id/accept-proposal", auth, (req, res) => {
  if (!providerOnly(req, res)) return undefined;
  return acceptPrice(req, res, req.user.id, ["provider"], "POST /offers/:id/accept-proposal");
});

// ================================
// REFUSER UNE CANDIDATURE (famille) — à toute étape avant l'accord
// ================================
async function rejectApplication(req, res) {
  try {
    if (!familyOnly(req, res)) return undefined;
    const { offer, app } = await loadApplication(req, res, { ...req.params, roles: ["family"] });
    if (!offer) return undefined;
    if (!apps.isOpen(app)) return res.status(400).json({ message: "Cette candidature a déjà été traitée" });
    const hadDiscussion = apps.isActive(app);
    closeApplication(app, "rejected", "rejected");
    if (offer.targetProvider) offer.status = "closed"; // proposition directe : plus personne d'autre
    await offer.save();
    if (hadDiscussion) await closeDiscussion(req.app.get("io"), offer, app, "rejected", "family");
    await notify(req.params.providerId, "Candidature non retenue", "La famille n’a pas retenu votre candidature pour cette offre.", "booking_rejected", offer._id, hadDiscussion ? app.sessionId : null);
    return res.json({ message: "Candidature refusée", application: apps.serializeApplication(app) });
  } catch (err) {
    return fail(res, err, "POST /offers/:offerId/reject/:providerId");
  }
}
router.post("/:offerId/reject/:providerId", auth, rejectApplication);
router.post("/:offerId/applications/:providerId/reject", auth, rejectApplication);

// ================================
// DÉCLINER UNE PROPOSITION DIRECTE (prestataire ciblé) — à toute étape avant l'accord
// ================================
async function declineDirect(req, res, offer, app) {
  if (offer.status !== "open" || (app && !apps.isOpen(app))) {
    return res.status(400).json({ message: "Cette proposition a déjà été traitée" });
  }
  const hadDiscussion = app && apps.isActive(app);
  if (app) closeApplication(app, "withdrawn", "declined");
  offer.status = "closed";
  await offer.save();
  if (hadDiscussion) await closeDiscussion(req.app.get("io"), offer, app, "declined", "provider");
  await notify(offer.family, "Proposition déclinée", "Le prestataire a décliné votre proposition. Vous pouvez en contacter un autre.", "booking_rejected", offer._id);
  return res.json({ message: "Proposition déclinée" });
}

router.post("/:id/decline", auth, async (req, res) => {
  try {
    if (!providerOnly(req, res)) return undefined;
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (!offer.targetProvider || idOf(offer.targetProvider) !== req.user.id) {
      return res.status(403).json({ message: "Non autorisé" });
    }
    const app = offer.applications.find((a) => idOf(a.provider) === req.user.id);
    return await declineDirect(req, res, offer, app);
  } catch (err) {
    return fail(res, err, "POST /offers/:id/decline");
  }
});

// ================================
// SE RETIRER (prestataire) — à toute étape avant l'accord ; impossible de recandidater ensuite.
// Discussion ouverte : fermée.
// Proposition directe : équivaut à « Décliner ».
// ================================
async function withdraw(req, res) {
  try {
    if (!providerOnly(req, res)) return undefined;
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    const app = offer.applications.find((a) => idOf(a.provider) === req.user.id);
    if (!app) return res.status(404).json({ message: "Candidature introuvable" });
    if (!apps.isOpen(app)) return res.status(400).json({ message: "Cette candidature a déjà été traitée" });
    if (offer.targetProvider) return await declineDirect(req, res, offer, app);
    // La candidature reste enregistrée (retirée) : on ne peut plus recandidater à cette offre.
    const hadDiscussion = apps.isActive(app);
    closeApplication(app, "withdrawn", "withdrawn");
    await offer.save();
    if (!hadDiscussion) return res.json({ message: "Candidature retirée", application: apps.serializeApplication(app) });
    await closeDiscussion(req.app.get("io"), offer, app, "withdrawn", "provider");
    await notify(offer.family, "Candidature retirée", "Un prestataire s'est retiré de la discussion. Vous pouvez discuter avec un autre candidat.", "booking_cancelled", offer._id, app.sessionId);
    return res.json({ message: "Candidature retirée", application: apps.serializeApplication(app) });
  } catch (err) {
    return fail(res, err, "DELETE /offers/:id/withdraw");
  }
}
router.delete("/:id/withdraw", auth, applyLimiter, withdraw);
router.post("/:id/withdraw", auth, applyLimiter, withdraw);

module.exports = router;

module.exports.limiters = { offerWriteLimiter, directOfferLimiter, applyLimiter };
