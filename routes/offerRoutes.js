const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const Offer = require("../models/Offer");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { PUBLIC_PROVIDER_FIELDS } = require("../controllers/nannyController");
const { validateOffer, readAmount, readMessage, MAX_COUNTERS } = require("../validators/offer");

// Champs d'une famille visibles par les prestataires : jamais de téléphone ni d'email.
const PUBLIC_FAMILY_FIELDS = "firstName lastName city commune photo";
const PROVIDER_FIELDS = Array.isArray(PUBLIC_PROVIDER_FIELDS) ? PUBLIC_PROVIDER_FIELDS.join(" ") : PUBLIC_PROVIDER_FIELDS;

// ================================
// OUTILS
// ================================
const isProviderRole = (role) => role === "nanny" || role === "tutor";
const idOf = (v) => (v && v._id ? v._id : v)?.toString();

// Identifiants d'URL validés une fois pour toutes (400 au lieu d'une erreur serveur).
for (const name of ["id", "offerId", "providerId"]) {
  router.param(name, (req, res, next, value) => {
    if (!mongoose.isValidObjectId(value)) return res.status(400).json({ message: "Identifiant invalide" });
    return next();
  });
}

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
  console.error(where, err);
  return res.status(500).json({ message: "Une erreur est survenue. Réessayez." });
}

// Une notification qui échoue ne doit pas faire échouer l'action.
async function notify(userId, title, message, type, offerId) {
  try {
    await Notification.create({ userId, title, message, type, metadata: { offerId } });
  } catch (err) {
    console.error("notification", err);
  }
}

const formatPrice = (n) => `${Number(n).toLocaleString("fr-FR")} FCFA`;

// Contre-propositions faites par une partie (la proposition initiale ne compte pas).
function countersUsed(app, by) {
  const history = app.history || [];
  return history.filter((h, i) => i > 0 && h.by === by).length;
}
const countersLeft = (app) => ({
  family: Math.max(0, MAX_COUNTERS - countersUsed(app, "family")),
  provider: Math.max(0, MAX_COUNTERS - countersUsed(app, "provider")),
});
// Auteur de la dernière proposition. Candidature créée avant la négociation (sans historique) :
// proposition directe = proposition de la famille ; candidature à une offre publique = du prestataire.
function lastBy(app, offer) {
  if (app.history && app.history.length) return app.lastOfferBy === "family" ? "family" : "provider";
  return offer && offer.targetProvider ? "family" : "provider";
}
const turnOf = (app, offer) => (lastBy(app, offer) === "family" ? "provider" : "family");

function serializeApplication(app, offer) {
  const a = typeof app.toObject === "function" ? app.toObject() : { ...app };
  return { ...a, lastOfferBy: lastBy(a, offer), history: a.history || [], countersLeft: countersLeft(a), turn: turnOf(a, offer) };
}

// Vue prestataire : sa propre candidature uniquement (pas celles des concurrents).
function serializeForProvider(offer, userId) {
  const o = typeof offer.toObject === "function" ? offer.toObject() : { ...offer };
  const mine = (o.applications || []).find((a) => idOf(a.provider) === userId);
  const { applications, acceptedProvider, ...rest } = o;
  return {
    ...rest,
    agreedPrice: idOf(acceptedProvider) === userId ? o.agreedPrice : null,
    isDirectOffer: !!o.targetProvider,
    applicantsCount: (applications || []).length,
    myApplication: mine ? serializeApplication(mine, o) : null,
  };
}

function serializeForFamily(offer) {
  const o = typeof offer.toObject === "function" ? offer.toObject() : { ...offer };
  return { ...o, applications: (o.applications || []).map((a) => serializeApplication(a, o)) };
}

// Conclut l'accord : candidature acceptée au prix sur la table, les autres refusées.
async function conclude(offer, app, acceptedBy) {
  const providerId = idOf(app.provider);
  const rejected = [];
  for (const a of offer.applications) {
    if (a === app) a.status = "accepted";
    else if (a.status === "pending") { a.status = "rejected"; rejected.push(idOf(a.provider)); }
  }
  offer.status = "closed";
  offer.acceptedProvider = app.provider;
  offer.agreedPrice = app.proposedPrice || offer.price || null;
  offer.acceptedAt = new Date();
  await offer.save();

  const price = offer.agreedPrice ? ` à ${formatPrice(offer.agreedPrice)}` : "";
  if (acceptedBy === "family") {
    await notify(providerId, "Candidature acceptée 🎉", `La famille a accepté votre candidature${price}. La suite se passe dans le chat ISD.`, "booking_accepted", offer._id);
  } else {
    await notify(offer.family, "Proposition acceptée 🎉", `Le prestataire a accepté votre proposition${price}. La suite se passe dans le chat ISD.`, "booking_accepted", offer._id);
  }
  for (const id of rejected) {
    await notify(id, "Candidature non retenue", "La famille a choisi un autre prestataire pour cette offre. D’autres offres vous attendent !", "booking_rejected", offer._id);
  }
}

// Ferme une offre : les candidatures en attente sont refusées ; renvoie l'envoi des avis.
function closePending(offer, reason) {
  const ids = [];
  for (const a of offer.applications) if (a.status === "pending") { a.status = "rejected"; ids.push(idOf(a.provider)); }
  return async () => { for (const id of ids) await notify(id, "Offre fermée", reason, "booking_rejected", offer._id); };
}

// ================================
// CRÉER UNE OFFRE (famille)
// Avec targetProvider : proposition directe à un prestataire précis.
// ================================
router.post("/", auth, async (req, res) => {
  try {
    if (!familyOnly(req, res)) return undefined;
    const { data, errors } = validateOffer(req.body);
    const { targetProvider } = req.body || {};
    let provider = null;
    if (targetProvider !== undefined && targetProvider !== null && targetProvider !== "") {
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
    if (provider && !errors.targetProvider && !data.price && !provider.pricingAmount) errors.price = "Proposez un prix pour ce prestataire";
    if (Object.keys(errors).length) {
      return res.status(400).json({ message: "Merci de corriger les champs en surbrillance", errors });
    }

    const offerData = { ...data, family: req.user.id };
    if (provider) {
      // Proposition directe : la famille propose son prix (ou accepte le tarif affiché),
      // c'est au prestataire de répondre.
      const amount = data.price || provider.pricingAmount;
      offerData.targetProvider = provider._id;
      offerData.price = amount;
      offerData.applications = [{
        provider: provider._id, status: "pending", proposedPrice: amount, lastOfferBy: "family",
        history: [{ by: "family", amount }],
      }];
    }
    const offer = await Offer.create(offerData);
    if (provider) {
      await notify(provider._id, "Nouvelle proposition directe", `Une famille vous propose une collaboration à ${formatPrice(offerData.price)}. Acceptez, contre-proposez ou déclinez.`, "booking_request", offer._id);
    }
    return res.status(201).json({ message: "Offre créée", offer });
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
router.put("/:id", auth, async (req, res) => {
  try {
    if (!familyOnly(req, res)) return undefined;
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (idOf(offer.family) !== req.user.id) return res.status(403).json({ message: "Non autorisé" });
    if (offer.status === "closed") return res.status(400).json({ message: "Impossible de modifier une offre fermée" });
    if (offer.targetProvider) return res.status(400).json({ message: "Une proposition directe se négocie par contre-proposition" });
    const { data, errors } = validateOffer(req.body, { partial: true, serviceType: offer.serviceType });
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
    const sendNotices = closePending(offer, "La famille a fermé cette offre.");
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
    const sendNotices = closePending(offer, "La famille a retiré cette offre.");
    await offer.deleteOne();
    await sendNotices();
    return res.json({ message: "Offre supprimée" });
  } catch (err) {
    return fail(res, err, "DELETE /offers/:id");
  }
});

// ================================
// CANDIDATER À UNE OFFRE PUBLIQUE (prestataire)
// body : { proposedPrice?, message? } — sans prix : celui de l'offre, sinon mon tarif.
// ================================
router.post("/:id/apply", auth, async (req, res) => {
  try {
    if (!providerOnly(req, res)) return undefined;
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (offer.status !== "open") return res.status(400).json({ message: "Cette offre est fermée" });
    if (offer.serviceType && offer.serviceType !== req.user.role) {
      return res.status(403).json({ message: "Cette offre concerne un autre type de prestataire" });
    }
    if (offer.targetProvider) {
      return res.status(400).json({ message: "Proposition directe : acceptez, contre-proposez ou déclinez-la." });
    }
    if (offer.applications.some((a) => idOf(a.provider) === req.user.id)) {
      return res.status(400).json({ message: "Vous avez déjà candidaté" });
    }

    const body = req.body || {};
    const msg = readMessage(body.message);
    if (msg.error) return res.status(400).json({ message: msg.error, errors: { message: msg.error } });
    let amount;
    if (body.proposedPrice !== undefined && body.proposedPrice !== null) {
      const a = readAmount(body.proposedPrice);
      if (a.error) return res.status(400).json({ message: a.error, errors: { proposedPrice: a.error } });
      amount = a.value;
    } else if (offer.price) {
      amount = offer.price;
    } else {
      const me = await User.findById(req.user.id).select("pricingAmount").lean();
      amount = me?.pricingAmount;
      if (!amount) return res.status(400).json({ message: "Indiquez votre prix", errors: { proposedPrice: "Indiquez votre prix" } });
    }

    offer.applications.push({
      provider: req.user.id, status: "pending", proposedPrice: amount, lastOfferBy: "provider",
      history: [{ by: "provider", amount }], message: msg.value,
    });
    await offer.save();

    const same = offer.price && amount === offer.price;
    await notify(
      offer.family, "Nouvelle candidature",
      same ? `Un prestataire accepte votre budget de ${formatPrice(amount)}.` : `Un prestataire candidate à ${formatPrice(amount)}.`,
      "booking_request", offer._id
    );
    return res.status(201).json({ message: "Candidature envoyée", offer: serializeForProvider(offer, req.user.id) });
  } catch (err) {
    return fail(res, err, "POST /offers/:id/apply");
  }
});

// ================================
// RETIRER MA CANDIDATURE (prestataire) — tant qu'elle est en attente
// ================================
router.delete("/:id/withdraw", auth, async (req, res) => {
  try {
    if (!providerOnly(req, res)) return undefined;
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    const index = offer.applications.findIndex((a) => idOf(a.provider) === req.user.id);
    if (index === -1) return res.status(404).json({ message: "Candidature introuvable" });
    if (offer.applications[index].status !== "pending") {
      return res.status(400).json({ message: "Cette candidature a déjà été traitée" });
    }
    if (offer.targetProvider) return res.status(400).json({ message: "Pour une proposition directe, utilisez « Décliner »." });
    offer.applications.splice(index, 1);
    await offer.save();
    return res.json({ message: "Candidature retirée" });
  } catch (err) {
    return fail(res, err, "DELETE /offers/:id/withdraw");
  }
});

// ================================
// DÉCLINER UNE PROPOSITION DIRECTE (prestataire ciblé)
// ================================
router.post("/:id/decline", auth, async (req, res) => {
  try {
    if (!providerOnly(req, res)) return undefined;
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (!offer.targetProvider || idOf(offer.targetProvider) !== req.user.id) {
      return res.status(403).json({ message: "Non autorisé" });
    }
    const app = offer.applications.find((a) => idOf(a.provider) === req.user.id);
    if (offer.status !== "open" || (app && app.status !== "pending")) {
      return res.status(400).json({ message: "Cette proposition a déjà été traitée" });
    }
    if (app) app.status = "rejected";
    offer.status = "closed";
    await offer.save();
    await notify(offer.family, "Proposition déclinée", "Le prestataire a décliné votre proposition. Vous pouvez en contacter un autre.", "booking_rejected", offer._id);
    return res.json({ message: "Proposition déclinée" });
  } catch (err) {
    return fail(res, err, "POST /offers/:id/decline");
  }
});

// ================================
// CONTRE-PROPOSER UN PRIX (famille propriétaire OU prestataire concerné)
// Chacun son tour, 3 contre-propositions maximum par partie.
// ================================
router.post("/:offerId/applications/:providerId/counter", auth, async (req, res) => {
  try {
    const actor = req.user.role === "family" ? "family" : isProviderRole(req.user.role) ? "provider" : null;
    if (!actor) return res.status(403).json({ message: "Non autorisé" });
    const offer = await Offer.findById(req.params.offerId);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (actor === "family" && idOf(offer.family) !== req.user.id) return res.status(403).json({ message: "Non autorisé" });
    if (actor === "provider" && req.params.providerId !== req.user.id) return res.status(403).json({ message: "Non autorisé" });
    if (offer.status !== "open") return res.status(400).json({ message: "Cette offre est fermée" });

    const app = offer.applications.find((a) => idOf(a.provider) === req.params.providerId);
    if (!app) return res.status(404).json({ message: "Candidature introuvable" });
    if (app.status !== "pending") return res.status(400).json({ message: "Cette candidature a déjà été traitée" });
    if (turnOf(app, offer) !== actor) return res.status(409).json({ message: "C’est à l’autre partie de répondre à votre dernière proposition." });
    if (countersUsed(app, actor) >= MAX_COUNTERS) {
      return res.status(409).json({ message: `Vous avez utilisé vos ${MAX_COUNTERS} contre-propositions : acceptez ou refusez le dernier prix.` });
    }
    const a = readAmount((req.body || {}).amount);
    if (a.error) return res.status(400).json({ message: a.error, errors: { amount: a.error } });
    if (a.value === app.proposedPrice) return res.status(400).json({ message: "Ce prix est déjà sur la table : acceptez-le plutôt." });

    if (!app.history || app.history.length === 0) {
      // Ancienne candidature sans historique : on garde la trace du prix de départ.
      app.history = [{ by: lastBy(app, offer), amount: app.proposedPrice || offer.price || a.value }];
    }
    app.history.push({ by: actor, amount: a.value });
    app.proposedPrice = a.value;
    app.lastOfferBy = actor;
    await offer.save();

    const target = actor === "family" ? req.params.providerId : offer.family;
    await notify(
      target, "Contre-proposition",
      actor === "family" ? `La famille vous propose ${formatPrice(a.value)}.` : `Un prestataire vous propose ${formatPrice(a.value)}.`,
      "offer_counter", offer._id
    );
    return res.json({ message: "Contre-proposition envoyée", application: serializeApplication(app, offer) });
  } catch (err) {
    return fail(res, err, "POST /offers/:offerId/applications/:providerId/counter");
  }
});

// ================================
// ACCEPTER UNE CANDIDATURE (famille) — au prix proposé par le prestataire
// Les autres candidatures en attente sont refusées automatiquement.
// ================================
router.post("/:offerId/accept/:providerId", auth, async (req, res) => {
  try {
    if (!familyOnly(req, res)) return undefined;
    const offer = await Offer.findById(req.params.offerId);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (idOf(offer.family) !== req.user.id) return res.status(403).json({ message: "Non autorisé" });
    if (offer.status !== "open") return res.status(400).json({ message: "Cette offre est fermée" });
    const app = offer.applications.find((a) => idOf(a.provider) === req.params.providerId && a.status === "pending");
    if (!app) return res.status(404).json({ message: "Candidature introuvable ou déjà traitée" });
    if (turnOf(app, offer) !== "family") {
      return res.status(409).json({ message: "Votre dernière proposition attend la réponse du prestataire." });
    }
    await conclude(offer, app, "family");
    return res.json({ message: "Candidature acceptée", offer: serializeForFamily(offer) });
  } catch (err) {
    return fail(res, err, "POST /offers/:offerId/accept/:providerId");
  }
});

// ================================
// ACCEPTER LA PROPOSITION DE LA FAMILLE (prestataire)
// Proposition directe ou contre-proposition : l'accord est conclu immédiatement.
// ================================
router.post("/:id/accept-proposal", auth, async (req, res) => {
  try {
    if (!providerOnly(req, res)) return undefined;
    const offer = await Offer.findById(req.params.id);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (offer.status !== "open") return res.status(400).json({ message: "Cette offre est fermée" });
    const app = offer.applications.find((a) => idOf(a.provider) === req.user.id);
    if (!app || app.status !== "pending") return res.status(404).json({ message: "Proposition introuvable ou déjà traitée" });
    if (turnOf(app, offer) !== "provider") {
      return res.status(409).json({ message: "Votre proposition attend la réponse de la famille." });
    }
    await conclude(offer, app, "provider");
    return res.json({ message: "Proposition acceptée", offer: serializeForProvider(offer, req.user.id) });
  } catch (err) {
    return fail(res, err, "POST /offers/:id/accept-proposal");
  }
});

// ================================
// REFUSER UNE CANDIDATURE (famille)
// ================================
router.post("/:offerId/reject/:providerId", auth, async (req, res) => {
  try {
    if (!familyOnly(req, res)) return undefined;
    const offer = await Offer.findById(req.params.offerId);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    if (idOf(offer.family) !== req.user.id) return res.status(403).json({ message: "Non autorisé" });
    const app = offer.applications.find((a) => idOf(a.provider) === req.params.providerId);
    if (!app) return res.status(404).json({ message: "Candidature introuvable" });
    if (app.status !== "pending") return res.status(400).json({ message: "Cette candidature a déjà été traitée" });
    app.status = "rejected";
    if (offer.targetProvider) offer.status = "closed"; // proposition directe : plus personne d'autre
    await offer.save();
    await notify(req.params.providerId, "Candidature non retenue", "La famille n’a pas retenu votre candidature pour cette offre.", "booking_rejected", offer._id);
    return res.json({ message: "Candidature refusée" });
  } catch (err) {
    return fail(res, err, "POST /offers/:offerId/reject/:providerId");
  }
});

module.exports = router;
