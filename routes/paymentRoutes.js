// Facture ISD, paiement (manuel ou CinetPay), coordonnées, contrat et garantie de remplacement.
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const Invoice = require("../models/Invoice");
const Contract = require("../models/Contract");
const Offer = require("../models/Offer");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { ChatSession } = require("../models/Chat");
const chat = require("../services/chat");
const payment = require("../services/payment");
const cinetpay = require("../services/cinetpay");
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
      const [offer, other] = await Promise.all([
        Offer.findById(inv.offerId).select("description serviceType city agreedPrice duration").lean(),
        User.findById(role === "family" ? inv.provider : inv.family).select("firstName lastName photo role").lean(),
      ]);
      return { ...serializeInvoice(inv, role), role, offer, other };
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
// CONTRAT ISD
// ================================
router.get("/:offerId/contract", auth, async (req, res) => {
  try {
    const { invoice, role } = await loadInvoice(req, res);
    if (!invoice) return undefined;
    if (invoice.status !== "paid") return res.status(403).json({ message: "Le contrat est disponible après le paiement de la facture ISD." });
    const doc = await payment.ensureContract(invoice);
    const contract = typeof doc?.toObject === "function" ? doc.toObject() : doc;
    if (!contract) return res.status(404).json({ message: "Contrat introuvable" });
    return res.json({ contract: { ...contract, terms: { ...contract.terms, guaranteeUntil: invoice.guaranteeUntil } }, role });
  } catch (err) {
    return serverError(res, err);
  }
});

router.post("/:offerId/contract/accept", auth, async (req, res) => {
  try {
    const { invoice, role } = await loadInvoice(req, res);
    if (!invoice) return undefined;
    if (invoice.status !== "paid") return res.status(403).json({ message: "Le contrat est disponible après le paiement de la facture ISD." });
    const contract = await payment.ensureContract(invoice);
    if (!contract) return res.status(404).json({ message: "Contrat introuvable" });
    if (!contract.acceptedAt) contract.acceptedAt = {};
    if (!contract.acceptedAt[role]) {
      contract.acceptedAt[role] = new Date();
      await contract.save();
      const other = role === "family" ? invoice.provider : invoice.family;
      await chat.notify(other, "Contrat ISD accepté", role === "family" ? "La famille a accepté le contrat ISD." : "Le prestataire a accepté le contrat ISD.", invoice.offerId);
    }
    return res.json({ acceptedAt: contract.acceptedAt });
  } catch (err) {
    return serverError(res, err);
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
    if (!invoice.guaranteeUntil || new Date() > invoice.guaranteeUntil) return res.status(409).json({ message: "La période de garantie est terminée." });

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

    const contract = await Contract.findOne({ offerId: invoice.offerId });
    if (contract && !contract.endedAt) { contract.endedAt = new Date(); contract.endReason = "replacement"; await contract.save(); }

    const io = req.app.get("io");
    const session = await ChatSession.findOne({ offerId: invoice.offerId });
    if (session) {
      session.status = "closed";
      session.closedReason = "replacement";
      session.closedBy = "family";
      await session.save();
      const msg = await chat.systemMessage(session, "La famille a demandé un remplacement au titre de la garantie ISD. Cette mission prend fin ; merci pour votre engagement.", { meta: { kind: "replacement" } });
      chat.emitMessage(io, msg);
      chat.emitSession(io, session);
    }
    await chat.notify(invoice.provider, "Fin de mission", "La famille a demandé un remplacement au titre de la garantie ISD. D'autres offres vous attendent.", invoice.offerId);
    return res.status(201).json({ message: "Votre offre est republiée. La prochaine mise en relation est offerte.", replacementOfferId: replacement._id });
  } catch (err) {
    if (err?.name === "VersionError") return res.status(409).json({ message: "La facture vient d'être modifiée. Réessayez." });
    return serverError(res, err);
  }
});

module.exports = router;
