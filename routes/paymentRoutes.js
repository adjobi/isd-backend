// Facture ISD, paiement (manuel ou CinetPay), coordonnées, récapitulatif des engagements et garantie de remplacement.
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const Invoice = require("../models/Invoice");
const Contract = require("../models/Contract");
const Offer = require("../models/Offer");
const User = require("../models/User");
const Notification = require("../models/Notification");
const Report = require("../models/Report");
const { ChatSession } = require("../models/Chat");
const chat = require("../services/chat");
const payment = require("../services/payment");
const cinetpay = require("../services/cinetpay");
const engagement = require("../services/engagement");
const { containsChatContact } = require("../validators/contact");

const OPERATORS = ["wave", "orange", "mtn", "moov"];
const MAX_DECLARATIONS = 5;
const CONTACT_FIELDS = "firstName lastName phone email city commune role";

router.param("offerId", (req, res, next, id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Identifiant invalide" });
  return next();
});

const serverError = (res, err) => {
  console.error("paiement", err);
  return res.status(500).json({ message: "Erreur serveur. Réessayez dans un instant." });
};

// Facture de l'offre (créée si la date de début est convenue) et rôle de l'utilisateur.
async function loadInvoice(req, res) {
  let invoice = await Invoice.findOne({ offerId: req.params.offerId });
  if (!invoice) {
    const session = await ChatSession.findOne({ offerId: req.params.offerId });
    if (session && chat.participantRole(session, req.user.id) && session.startDate) {
      invoice = await payment.ensureInvoice(session, req.app.get("io"));
    }
  }
  const role = payment.invoiceRole(invoice, req.user.id);
  if (!invoice || !role) {
    res.status(404).json({ message: "Facture introuvable. Elle est créée quand la date de début est convenue dans le chat." });
    return {};
  }
  return { invoice, role };
}

function serializeInvoice(invoice, role) {
  const o = typeof invoice.toObject === "function" ? invoice.toObject() : { ...invoice };
  const out = {
    _id: o._id, offerId: o.offerId, reference: o.reference, amount: o.amount, currency: o.currency,
    breakdown: o.breakdown, status: o.status, method: o.method, startDate: o.startDate, paidAt: o.paidAt,
    guaranteeUntil: o.guaranteeUntil, guaranteeUsedAt: o.guaranteeUsedAt, replacementOfferId: o.replacementOfferId,
    createdAt: o.createdAt,
  };
  if (role === "family") {
    out.declaration = o.declaration;
    out.rejectReason = o.rejectReason;
    out.declarationsLeft = Math.max(0, MAX_DECLARATIONS - (o.declarationCount || 0));
  }
  return out;
}

const paymentInfo = () => ({
  number: process.env.ISD_MOBILE_MONEY_NUMBER || null,
  operators: OPERATORS,
  automatic: cinetpay.isConfigured(),
});

// ================================
// MES MISSIONS (factures où je suis famille ou prestataire)
// ================================
router.get("/mine", auth, async (req, res) => {
  try {
    const me = req.user.id;
    const invoices = await Invoice.find({ $or: [{ family: me }, { provider: me }] }).sort({ createdAt: -1 }).limit(50).lean();
    const list = await Promise.all(invoices.map(async (inv) => {
      const role = payment.invoiceRole(inv, me);
      const [offer, other, contract] = await Promise.all([
        Offer.findById(inv.offerId).select("description serviceType city agreedPrice duration").lean(),
        User.findById(role === "family" ? inv.provider : inv.family).select("firstName lastName photo role").lean(),
        inv.status === "paid" ? Contract.findOne({ offerId: inv.offerId }).select("acceptedAt endedAt").lean() : null,
      ]);
      // État de la mission : à confirmer, en cours, fin programmée, terminée
      const mission = contract ? { state: engagement.stateOf(contract), endedAt: contract.endedAt } : null;
      return { ...serializeInvoice(inv, role), role, offer, other, mission };
    }));
    return res.json(list);
  } catch (err) {
    return serverError(res, err);
  }
});

// ================================
// RETOUR APRÈS PAIEMENT CINETPAY (page affichée dans le navigateur)
// ================================
router.get("/cinetpay/return", (req, res) => {
  res.type("html").send("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>ISD</title><body style='font-family:sans-serif;text-align:center;padding:48px 24px;background:#FBF5EC;color:#2B2420'><h2>Merci !</h2><p>Votre paiement est en cours de confirmation. Vous pouvez revenir dans l'application ISD.</p></body>");
});
router.post("/cinetpay/return", (req, res) => res.redirect(303, "return"));

// ================================
// NOTIFICATION CINETPAY (webhook) : le statut est revérifié auprès de CinetPay.
// ================================
router.post("/cinetpay/notify", express.urlencoded({ extended: false, limit: "20kb" }), async (req, res) => {
  try {
    const transactionId = String(req.body?.cpm_trans_id || "");
    if (!cinetpay.isConfigured() || !transactionId || String(req.body?.cpm_site_id || "") !== cinetpay.config().siteId) {
      return res.status(200).send("ignoré");
    }
    const invoice = await Invoice.findOne({ "gateway.transactionId": transactionId });
    if (!invoice || invoice.status === "paid") return res.status(200).send("ok");
    const check = await cinetpay.checkPayment(transactionId);
    invoice.gateway.status = check.status;
    if (check.accepted && check.currency === "XOF" && check.amount >= invoice.amount) {
      await payment.markPaid(invoice, { method: "cinetpay", io: req.app.get("io") });
    } else {
      await invoice.save();
    }
    return res.status(200).send("ok");
  } catch (err) {
    console.error("cinetpay notify", err);
    return res.status(200).send("erreur"); // CinetPay réessaiera
  }
});

// ================================
// FACTURE D'UNE OFFRE
// ================================
router.get("/:offerId", auth, async (req, res) => {
  try {
    const { invoice, role } = await loadInvoice(req, res);
    if (!invoice) return undefined;
    return res.json({ invoice: serializeInvoice(invoice, role), role, payment: paymentInfo() });
  } catch (err) {
    return serverError(res, err);
  }
});

// ================================
// PAIEMENT MANUEL : la famille déclare son paiement Mobile Money
// ================================
router.post("/:offerId/declare", auth, async (req, res) => {
  try {
    const operator = req.body?.operator;
    const ref = typeof req.body?.transactionRef === "string" ? req.body.transactionRef.trim().toUpperCase() : "";
    const errors = {};
    if (!OPERATORS.includes(operator)) errors.operator = "Choisissez l'opérateur utilisé";
    if (!/^[A-Z0-9.\-_]{4,40}$/.test(ref)) errors.transactionRef = "Identifiant de transaction invalide (lettres et chiffres, 4 à 40 caractères)";
    if (Object.keys(errors).length) return res.status(400).json({ message: "Vérifiez les informations saisies", errors });

    const { invoice, role } = await loadInvoice(req, res);
    if (!invoice) return undefined;
    if (role !== "family") return res.status(403).json({ message: "Seule la famille règle la facture ISD." });
    if (!["pending", "rejected"].includes(invoice.status)) {
      return res.status(409).json({ message: invoice.status === "submitted" ? "Paiement déjà déclaré : vérification en cours." : "Cette facture est déjà réglée." });
    }
    if ((invoice.declarationCount || 0) >= MAX_DECLARATIONS) {
      return res.status(429).json({ message: "Trop de déclarations. Contactez le support ISD." });
    }
    const duplicate = await Invoice.findOne({ _id: { $ne: invoice._id }, "declaration.transactionRef": ref, status: { $in: ["submitted", "paid"] } });
    if (duplicate) return res.status(409).json({ message: "Cet identifiant de transaction a déjà été utilisé.", errors: { transactionRef: "Déjà utilisé" } });

    invoice.declaration = { operator, transactionRef: ref, at: new Date() };
    invoice.declarationCount = (invoice.declarationCount || 0) + 1;
    invoice.status = "submitted";
    invoice.method = "manual";
    invoice.rejectReason = null;
    await invoice.save();

    const admins = await User.find({ isAdmin: true }).select("_id").lean();
    for (const a of admins) {
      try {
        await Notification.create({ userId: a._id, title: "Paiement à vérifier", message: `${payment.formatFCFA(invoice.amount)} · ${invoice.reference} · ${operator.toUpperCase()} ${ref}`, type: "system_alert", metadata: { offerId: invoice.offerId } });
      } catch (err) {
        console.error("notification admin", err);
      }
    }
    return res.json({ message: "Paiement déclaré. Vérification par l'équipe ISD en cours.", invoice: serializeInvoice(invoice, role) });
  } catch (err) {
    if (err?.name === "VersionError") return res.status(409).json({ message: "La facture vient d'être modifiée. Réessayez." });
    return serverError(res, err);
  }
});

// ================================
// PAIEMENT AUTOMATIQUE (CinetPay) : lien de paiement
// ================================
router.post("/:offerId/checkout", auth, async (req, res) => {
  try {
    const { invoice, role } = await loadInvoice(req, res);
    if (!invoice) return undefined;
    if (role !== "family") return res.status(403).json({ message: "Seule la famille règle la facture ISD." });
    if (!["pending", "rejected"].includes(invoice.status)) return res.status(409).json({ message: "Cette facture n'est plus à payer." });
    if (!cinetpay.isConfigured()) return res.status(503).json({ message: "Le paiement automatique arrive bientôt. Utilisez le paiement Mobile Money." });
    const family = await User.findById(invoice.family).select("firstName lastName").lean();
    const transactionId = `${invoice.reference}-${Date.now().toString(36).toUpperCase()}`;
    const { paymentUrl } = await cinetpay.initPayment({ transactionId, amount: invoice.amount, description: `Mise en relation ISD ${invoice.reference}`, customer: family });
    invoice.gateway = { transactionId, paymentUrl, status: "PENDING" };
    await invoice.save();
    return res.json({ paymentUrl });
  } catch (err) {
    if (err?.gateway) {
      console.error("cinetpay init", err.gateway);
      return res.status(502).json({ message: "Le service de paiement ne répond pas. Réessayez ou utilisez le paiement Mobile Money." });
    }
    return serverError(res, err);
  }
});

// ================================
// COORDONNÉES DE L'AUTRE PARTIE : uniquement facture réglée
// ================================
router.get("/:offerId/contacts", auth, async (req, res) => {
  try {
    const { invoice, role } = await loadInvoice(req, res);
    if (!invoice) return undefined;
    if (invoice.status !== "paid") return res.status(403).json({ message: "Les coordonnées sont disponibles après le paiement de la facture ISD." });
    const other = await User.findById(role === "family" ? invoice.provider : invoice.family).select(CONTACT_FIELDS).lean();
    return res.json({ contact: other });
  } catch (err) {
    return serverError(res, err);
  }
});

// ================================
// RÉCAPITULATIF DES ENGAGEMENTS (modèle Contract) : ISD retrace l'accord des deux parties
// ================================
const NOT_YET = "Le récapitulatif des engagements est disponible après le paiement de la facture ISD.";
const ROLE_NAME = { family: "La famille", provider: "Le prestataire" };

function serializeContract(doc, invoice, now = new Date()) {
  const c = typeof doc?.toObject === "function" ? doc.toObject() : { ...doc };
  const t = c.termination ? { ...c.termination, reasonLabel: engagement.REASON_LABELS[c.termination.reason] || "" } : null;
  return {
    ...c,
    state: engagement.stateOf(c, now),
    noticeDays: engagement.noticeDaysOf(c),
    termination: t,
    terms: { ...c.terms, guaranteeUntil: invoice.guaranteeUntil, commitments: c.terms?.commitments || engagement.COMMITMENTS },
    replacementAllowed: engagement.replacementAllowed(invoice, c, now),
  };
}

// Message ISD dans le chat de la mission (sans bloquer l'action en cas d'échec).
async function tellChat(io, offerId, text, meta, { close = false } = {}) {
  try {
    const session = await ChatSession.findOne({ offerId });
    if (!session) return;
    if (close && session.status !== "closed") {
      session.status = "closed";
      session.closedReason = "mission_ended";
      session.closedBy = "system";
      await session.save();
    }
    const msg = await chat.systemMessage(session, text, { meta });
    chat.emitMessage(io, msg);
    if (close) chat.emitSession(io, session);
  } catch (err) {
    console.error("chat engagements", err);
  }
}

const noticeLabel = (n) => (n === 0 ? "sans préavis" : `${n} jour${n > 1 ? "s" : ""} de préavis`);

async function loadContract(req, res) {
  const { invoice, role } = await loadInvoice(req, res);
  if (!invoice) return {};
  if (invoice.status !== "paid") { res.status(403).json({ message: NOT_YET }); return {}; }
  const contract = await payment.ensureContract(invoice);
  if (!contract) { res.status(404).json({ message: "Récapitulatif introuvable" }); return {}; }
  return { invoice, role, contract };
}

const contractError = (res, r) => res.status(r.status).json({ message: r.error, ...(r.field ? { errors: { [r.field]: r.error } } : {}) });
const handleConcurrency = (res, err) => {
  if (err?.name === "VersionError") return res.status(409).json({ message: "L'autre partie vient d'agir sur cette mission. Rechargez et réessayez." });
  return serverError(res, err);
};

router.get("/:offerId/contract", auth, async (req, res) => {
  try {
    const { invoice, role, contract } = await loadContract(req, res);
    if (!contract) return undefined;
    return res.json({ contract: serializeContract(contract, invoice), role });
  } catch (err) {
    return serverError(res, err);
  }
});

// Confirmation des engagements avec la durée de préavis retenue (proposer une autre durée
// annule la confirmation de l'autre partie, qui doit confirmer à nouveau).
router.post("/:offerId/contract/accept", auth, async (req, res) => {
  try {
    const { invoice, role, contract } = await loadContract(req, res);
    if (!contract) return undefined;
    const r = engagement.applyAccept(contract, role, req.body?.noticeDays);
    if (r.error) return contractError(res, r);
    if (!r.noop) {
      contract.markModified("terms");
      contract.markModified("acceptedAt");
      await contract.save();
      const other = role === "family" ? invoice.provider : invoice.family;
      const who = ROLE_NAME[role];
      const io = req.app.get("io");
      if (r.active) {
        await chat.notify(other, "Engagements confirmés ✅", `${who} a confirmé à son tour : vos engagements sont en vigueur (${noticeLabel(r.notice)}).`, invoice.offerId);
        await tellChat(io, invoice.offerId, `🤝 Engagements confirmés par les deux parties, avec ${noticeLabel(r.notice)}. Ils sont consultables à tout moment dans « Mission ».`, { kind: "engagements_confirmed" });
      } else if (r.proposed) {
        await chat.notify(other, "Préavis à confirmer", `${who} propose ${noticeLabel(r.notice)}. Confirmez ou proposez une autre durée dans « Mission ».`, invoice.offerId);
        await tellChat(io, invoice.offerId, `${who} propose ${noticeLabel(r.notice)} pour mettre fin à la mission. L'autre partie peut confirmer ou proposer une autre durée dans « Mission ».`, { kind: "notice_proposed" });
      } else {
        await chat.notify(other, "Engagements à confirmer", `${who} a confirmé le récapitulatif (${noticeLabel(r.notice)}). À vous de le confirmer dans « Mission ».`, invoice.offerId);
      }
    }
    return res.json({ contract: serializeContract(contract, invoice) });
  } catch (err) {
    return handleConcurrency(res, err);
  }
});

// Fin de mission : d'un commun accord (date proposée), avec préavis, ou immédiate pour faute grave.
router.post("/:offerId/contract/end", auth, async (req, res) => {
  try {
    const comment = typeof req.body?.comment === "string" ? req.body.comment : "";
    if (containsChatContact(comment)) return res.status(400).json({ message: "Pas de coordonnées dans les précisions", errors: { comment: "Pas de coordonnées" } });
    const { invoice, role, contract } = await loadContract(req, res);
    if (!contract) return undefined;
    const now = new Date();
    const r = engagement.planEnd(contract, role, req.body || {}, now);
    if (r.error) return contractError(res, r);

    contract.termination = r.termination;
    if (r.termination.mode !== "mutual") {
      contract.endedAt = r.termination.effectiveAt;
      contract.endReason = r.termination.mode;
      contract.endedBy = role;
    }
    await contract.save();

    const io = req.app.get("io");
    const other = role === "family" ? invoice.provider : invoice.family;
    const who = ROLE_NAME[role];
    const label = engagement.REASON_LABELS[r.termination.reason].toLowerCase();
    const day = chat.formatDay(r.termination.effectiveAt);
    if (r.termination.mode === "mutual") {
      await chat.notify(other, "Proposition de fin de mission", `${who} propose de terminer la mission le ${day}. Répondez dans « Mission ».`, invoice.offerId);
      await tellChat(io, invoice.offerId, `${who} propose de terminer la mission d'un commun accord le ${day} (motif : ${label}). L'autre partie peut accepter ou refuser dans « Mission ».`, { kind: "end_proposed" });
    } else if (r.termination.mode === "serious") {
      await Report.create({ offerId: invoice.offerId, contractId: contract._id, by: req.user.id, byRole: role, against: other, reason: r.termination.reason, comment: r.termination.comment });
      await chat.notify(other, "Fin de mission", `${who} a mis fin à la mission immédiatement et a signalé un problème grave à ISD. L'équipe ISD peut vous contacter.`, invoice.offerId);
      await tellChat(io, invoice.offerId, `${who} a mis fin à la mission avec effet immédiat pour un problème grave (motif : ${label}). L'équipe ISD a été prévenue et pourra contacter chacun d'entre vous.`, { kind: "ended" }, { close: true });
    } else if (r.endNow) {
      await chat.notify(other, "Fin de mission", `${who} a mis fin à la mission (motif : ${label}).`, invoice.offerId);
      await tellChat(io, invoice.offerId, `${who} a mis fin à la mission (motif : ${label}). Aucun préavis n'avait été convenu.`, { kind: "ended" });
    } else {
      await chat.notify(other, "Préavis de fin de mission", `${who} met fin à la mission avec ${noticeLabel(r.termination.noticeDays)} : dernier jour le ${day}.`, invoice.offerId);
      await tellChat(io, invoice.offerId, `${who} met fin à la mission en respectant le préavis convenu de ${r.termination.noticeDays} jour${r.termination.noticeDays > 1 ? "s" : ""}. La mission se termine le ${day} (motif : ${label}).`, { kind: "end_notice" });
    }
    return res.status(201).json({ contract: serializeContract(contract, invoice, now) });
  } catch (err) {
    return handleConcurrency(res, err);
  }
});

router.post("/:offerId/contract/end/respond", auth, async (req, res) => {
  try {
    const { accept } = req.body || {};
    if (typeof accept !== "boolean") return res.status(400).json({ message: "Réponse invalide" });
    const { invoice, role, contract } = await loadContract(req, res);
    if (!contract) return undefined;
    const now = new Date();
    const r = engagement.applyEndResponse(contract, role, accept, now);
    if (r.error) return contractError(res, r);
    contract.termination = r.termination;
    if (accept) {
      contract.endedAt = r.endedAt;
      contract.endReason = "mutual";
      contract.endedBy = r.termination.by;
    }
    await contract.save();

    const io = req.app.get("io");
    const proposer = r.termination.by === "family" ? invoice.family : invoice.provider;
    const day = chat.formatDay(r.termination.effectiveAt);
    if (accept) {
      await chat.notify(proposer, "Fin de mission acceptée", `La mission se termine d'un commun accord le ${day}.`, invoice.offerId);
      await tellChat(io, invoice.offerId, `🤝 Fin de mission convenue d'un commun accord : dernier jour le ${day}. Merci à tous les deux pour cette collaboration.`, { kind: "end_agreed" });
    } else {
      await chat.notify(proposer, "Fin de mission refusée", "Votre proposition de fin n'a pas été acceptée. Échangez dans le chat ou mettez fin à la mission avec le préavis convenu.", invoice.offerId);
      await tellChat(io, invoice.offerId, "La proposition de fin de mission n'a pas été acceptée : la mission continue. Vous pouvez en reparler dans ce chat.", { kind: "end_declined" });
    }
    return res.json({ contract: serializeContract(contract, invoice, now) });
  } catch (err) {
    return handleConcurrency(res, err);
  }
});

// Retrait d'une proposition de fin d'un commun accord (par son auteur, tant qu'elle est sans réponse).
router.post("/:offerId/contract/end/cancel", auth, async (req, res) => {
  try {
    const { invoice, role, contract } = await loadContract(req, res);
    if (!contract) return undefined;
    const t = contract.termination;
    if (!t || t.status !== "proposed") return res.status(409).json({ message: "Aucune proposition de fin en attente." });
    if (t.by !== role) return res.status(403).json({ message: "Seul l'auteur de la proposition peut la retirer." });
    contract.termination = null;
    await contract.save();
    const other = role === "family" ? invoice.provider : invoice.family;
    await chat.notify(other, "Proposition de fin retirée", `${ROLE_NAME[role]} a retiré sa proposition : la mission continue.`, invoice.offerId);
    await tellChat(req.app.get("io"), invoice.offerId, `${ROLE_NAME[role]} a retiré sa proposition de fin de mission : la mission continue.`, { kind: "end_cancelled" });
    return res.json({ contract: serializeContract(contract, invoice) });
  } catch (err) {
    return handleConcurrency(res, err);
  }
});

// ================================
// GARANTIE DE REMPLACEMENT : l'offre est republiée, la prochaine mise en relation est offerte
// ================================
router.post("/:offerId/replacement", auth, async (req, res) => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().replace(/\s+/g, " ") : "";
    if (reason.length < 10 || reason.length > 300) return res.status(400).json({ message: "Expliquez la raison en 10 à 300 caractères", errors: { reason: "10 à 300 caractères" } });
    if (containsChatContact(reason)) return res.status(400).json({ message: "Pas de coordonnées dans la raison", errors: { reason: "Pas de coordonnées" } });

    const { invoice, role } = await loadInvoice(req, res);
    if (!invoice) return undefined;
    if (role !== "family") return res.status(403).json({ message: "Seule la famille peut demander un remplacement." });
    if (invoice.status !== "paid") return res.status(409).json({ message: "La garantie s'applique après le paiement de la facture." });
    if (invoice.guaranteeUsedAt) return res.status(409).json({ message: "La garantie a déjà été utilisée pour cette mission." });
    const contract = await Contract.findOne({ offerId: invoice.offerId });
    if (!engagement.replacementAllowed(invoice, contract)) return res.status(409).json({ message: "La période de garantie est terminée." });

    const offer = await Offer.findById(invoice.offerId);
    if (!offer) return res.status(404).json({ message: "Offre introuvable" });
    const replacement = await Offer.create({
      family: offer.family, serviceType: offer.serviceType, description: offer.description, duration: offer.duration,
      price: offer.agreedPrice || offer.price || 0, subjects: offer.subjects || [], city: offer.city,
      status: "open", applications: [], replacementOf: offer._id, feeWaived: true,
    });
    invoice.guaranteeUsedAt = new Date();
    invoice.replacementOfferId = replacement._id;
    await invoice.save();

    // Mission déjà terminée ou en préavis : sa date de fin reste celle convenue.
    const alreadyEnding = !!contract?.endedAt;
    if (contract && !alreadyEnding) {
      contract.endedAt = new Date();
      contract.endReason = "replacement";
      contract.endedBy = "family";
      await contract.save();
    }

    const io = req.app.get("io");
    const session = await ChatSession.findOne({ offerId: invoice.offerId });
    if (session && !alreadyEnding) {
      session.status = "closed";
      session.closedReason = "replacement";
      session.closedBy = "family";
      await session.save();
      const msg = await chat.systemMessage(session, "La famille a demandé un remplacement au titre de la garantie ISD. Cette mission prend fin ; merci pour votre engagement.", { meta: { kind: "replacement" } });
      chat.emitMessage(io, msg);
      chat.emitSession(io, session);
    }
    if (!alreadyEnding) await chat.notify(invoice.provider, "Fin de mission", "La famille a demandé un remplacement au titre de la garantie ISD. D'autres offres vous attendent.", invoice.offerId);
    return res.status(201).json({ message: "Votre offre est republiée. La prochaine mise en relation est offerte.", replacementOfferId: replacement._id });
  } catch (err) {
    if (err?.name === "VersionError") return res.status(409).json({ message: "La facture vient d'être modifiée. Réessayez." });
    return serverError(res, err);
  }
});

module.exports = router;
