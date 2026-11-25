// Espace d'administration ISD : vérification des paiements et tarifs.
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const adminOnly = require("../middleware/admin");
const Invoice = require("../models/Invoice");
const Offer = require("../models/Offer");
const User = require("../models/User");
const Setting = require("../models/Setting");
const AdminLog = require("../models/AdminLog");
const Report = require("../models/Report");
const MissionReview = require("../models/MissionReview");
const { refreshProviderRating } = require("../services/reviews");
const { REASON_LABELS } = require("../services/engagement");
const chat = require("../services/chat");
const payment = require("../services/payment");
const { getPricing, validatePricing, launchActive } = require("../services/pricing");

const STATUSES = ["submitted", "pending", "paid", "rejected", "waived"];

router.use(auth, adminOnly);

router.param("reportId", (req, res, next, id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Identifiant invalide" });
  return next();
});

router.param("reviewId", (req, res, next, id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Identifiant invalide" });
  return next();
});

router.param("invoiceId", (req, res, next, id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Identifiant invalide" });
  return next();
});

const serverError = (res, err) => {
  console.error("admin", err);
  return res.status(500).json({ message: "Erreur serveur. Réessayez dans un instant." });
};

// Journal d'audit : un échec d'écriture est signalé dans les logs sans annuler l'action.
const audit = async (req, action, details = {}, invoice = null) => {
  try {
    await AdminLog.create({ admin: req.user.id, action, invoice, details, ip: req.ip || "" });
  } catch (err) {
    console.error("journal admin", action, err.message);
  }
};

// Un administrateur ne valide jamais une facture qui le concerne.
const selfInvolved = (invoice, userId) => !!payment.invoiceRole(invoice, userId);

// ================================
// PAIEMENTS (par défaut : à vérifier)
// ================================
router.get("/payments", async (req, res) => {
  try {
    const status = STATUSES.includes(req.query.status) ? req.query.status : "submitted";
    const invoices = await Invoice.find({ status }).sort({ updatedAt: status === "submitted" ? 1 : -1 }).limit(100).lean();
    const counts = Object.fromEntries(await Promise.all(["submitted", "pending"].map(async (s) => [s, await Invoice.countDocuments({ status: s })])));
    const list = await Promise.all(invoices.map(async (inv) => {
      const [family, provider, offer] = await Promise.all([
        User.findById(inv.family).select("firstName lastName phone").lean(),
        User.findById(inv.provider).select("firstName lastName phone role").lean(),
        Offer.findById(inv.offerId).select("description serviceType city").lean(),
      ]);
      return { ...inv, family, provider, offer, selfInvolved: selfInvolved(inv, req.user.id) };
    }));
    return res.json({ status, counts, invoices: list });
  } catch (err) {
    return serverError(res, err);
  }
});

router.post("/payments/:invoiceId/confirm", async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.invoiceId);
    if (!invoice) return res.status(404).json({ message: "Facture introuvable" });
    if (selfInvolved(invoice, req.user.id)) return res.status(403).json({ message: "Vous ne pouvez pas valider une facture qui vous concerne." });
    if (invoice.status !== "submitted") return res.status(409).json({ message: "Cette facture n'est pas en attente de vérification." });
    await payment.markPaid(invoice, { method: "manual", by: req.user.id, io: req.app.get("io") });
    await audit(req, "payment_confirmed", { reference: invoice.reference, amount: invoice.amount }, invoice._id);
    return res.json({ message: "Paiement confirmé", status: invoice.status });
  } catch (err) {
    if (err?.name === "VersionError") return res.status(409).json({ message: "La facture vient d'être modifiée. Rechargez." });
    return serverError(res, err);
  }
});

router.post("/payments/:invoiceId/reject", async (req, res) => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (reason.length < 5 || reason.length > 200) return res.status(400).json({ message: "Indiquez le motif (5 à 200 caractères)", errors: { reason: "5 à 200 caractères" } });
    const invoice = await Invoice.findById(req.params.invoiceId);
    if (!invoice) return res.status(404).json({ message: "Facture introuvable" });
    if (selfInvolved(invoice, req.user.id)) return res.status(403).json({ message: "Vous ne pouvez pas traiter une facture qui vous concerne." });
    if (invoice.status !== "submitted") return res.status(409).json({ message: "Cette facture n'est pas en attente de vérification." });
    invoice.status = "rejected";
    invoice.rejectReason = reason;
    invoice.verifiedBy = req.user.id;
    invoice.verifiedAt = new Date();
    await invoice.save();
    await audit(req, "payment_rejected", { reference: invoice.reference, reason }, invoice._id);
    await chat.notify(invoice.family, "Paiement non confirmé", `Motif : ${reason}. Vérifiez votre transaction et déclarez-la à nouveau.`, invoice.offerId);
    return res.json({ message: "Déclaration refusée", status: invoice.status });
  } catch (err) {
    if (err?.name === "VersionError") return res.status(409).json({ message: "La facture vient d'être modifiée. Rechargez." });
    return serverError(res, err);
  }
});

// ================================
// TARIFS (pourcentages exprimés en %)
// ================================
const pricingView = (p) => ({
  ratePercent: Math.round(p.rate * 10000) / 100,
  minFee: p.minFee,
  shortFlat: p.shortFlat,
  launchDiscountPercent: Math.round(p.launchDiscount * 10000) / 100,
  launchUntil: p.launchUntil,
  guaranteeDays: p.guaranteeDays,
  launchActive: launchActive(p),
});

router.get("/settings/pricing", async (req, res) => {
  try {
    return res.json(pricingView(await getPricing()));
  } catch (err) {
    return serverError(res, err);
  }
});

router.put("/settings/pricing", async (req, res) => {
  try {
    const { value, errors } = validatePricing(req.body);
    if (errors) return res.status(400).json({ message: "Vérifiez les valeurs saisies", errors });
    const before = await getPricing();
    await Setting.findOneAndUpdate({ key: "pricing" }, { $set: { value, updatedBy: req.user.id } }, { upsert: true, new: true });
    await audit(req, "pricing_updated", { before: pricingView(before), after: value });
    return res.json(pricingView(await getPricing()));
  } catch (err) {
    return serverError(res, err);
  }
});

// ================================
// SIGNALEMENTS (fins de mission pour faute grave)
// ================================
router.get("/reports", async (req, res) => {
  try {
    const status = req.query.status === "handled" ? "handled" : "open";
    const reports = await Report.find({ status }).sort({ createdAt: status === "open" ? 1 : -1 }).limit(100)
      .populate("by", "firstName lastName phone role").populate("against", "firstName lastName phone role")
      .populate("offerId", "description city serviceType").populate("handledBy", "firstName lastName").lean();
    const open = await Report.countDocuments({ status: "open" });
    return res.json({ status, open, reports: reports.map((r) => ({ ...r, reasonLabel: REASON_LABELS[r.reason] || r.reason })) });
  } catch (err) {
    return serverError(res, err);
  }
});

router.post("/reports/:reportId/handle", async (req, res) => {
  try {
    const note = typeof req.body?.note === "string" ? req.body.note.trim().replace(/\s+/g, " ") : "";
    if (note.length < 10 || note.length > 500) return res.status(400).json({ message: "Résumez la suite donnée en 10 à 500 caractères", errors: { note: "10 à 500 caractères" } });
    const report = await Report.findById(req.params.reportId);
    if (!report) return res.status(404).json({ message: "Signalement introuvable" });
    if (report.status === "handled") return res.status(409).json({ message: "Ce signalement est déjà traité." });
    if ([String(report.by), String(report.against)].includes(String(req.user.id))) {
      return res.status(403).json({ message: "Vous êtes concerné par ce signalement : un autre membre de l'équipe doit le traiter." });
    }
    report.status = "handled";
    report.handledBy = req.user.id;
    report.handledAt = new Date();
    report.note = note;
    await report.save();
    await audit(req, "report_handled", { reportId: String(report._id), note });
    return res.json({ report });
  } catch (err) {
    return serverError(res, err);
  }
});

// ================================
// AVIS DES FAMILLES (modération : publiés d'office, masquables avec motif)
// ================================
router.get("/reviews", async (req, res) => {
  try {
    const status = req.query.status === "hidden" ? "hidden" : "published";
    const list = await MissionReview.find({ status }).sort({ createdAt: -1 }).limit(100)
      .populate("family", "firstName lastName").populate("provider", "firstName lastName role")
      .populate("moderation.by", "firstName lastName").lean();
    const hidden = await MissionReview.countDocuments({ status: "hidden" });
    return res.json({ status, hidden, reviews: list });
  } catch (err) {
    return serverError(res, err);
  }
});

async function moderateReview(req, res, toStatus) {
  const note = typeof req.body?.note === "string" ? req.body.note.trim().replace(/\s+/g, " ") : "";
  if (note.length < 5 || note.length > 300) return res.status(400).json({ message: "Indiquez le motif en 5 à 300 caractères", errors: { note: "5 à 300 caractères" } });
  const review = await MissionReview.findById(req.params.reviewId);
  if (!review) return res.status(404).json({ message: "Avis introuvable" });
  if (review.status === toStatus) return res.status(409).json({ message: toStatus === "hidden" ? "Cet avis est déjà masqué." : "Cet avis est déjà publié." });
  if ([String(review.family), String(review.provider)].includes(String(req.user.id))) {
    return res.status(403).json({ message: "Vous êtes concerné par cet avis : un autre membre de l'équipe doit s'en occuper." });
  }
  review.status = toStatus;
  review.moderation = { by: req.user.id, at: new Date(), note };
  await review.save();
  await refreshProviderRating(review.provider);
  await audit(req, toStatus === "hidden" ? "review_hidden" : "review_shown", { reviewId: String(review._id), rating: review.rating, note });
  return res.json({ review });
}
router.post("/reviews/:reviewId/hide", (req, res) => moderateReview(req, res, "hidden").catch((err) => serverError(res, err)));
router.post("/reviews/:reviewId/show", (req, res) => moderateReview(req, res, "published").catch((err) => serverError(res, err)));

// ================================
// JOURNAL DES ACTIONS (100 dernières)
// ================================
router.get("/logs", async (req, res) => {
  try {
    const logs = await AdminLog.find().sort({ createdAt: -1 }).limit(100).populate("admin", "firstName lastName email").lean();
    return res.json({ logs });
  } catch (err) {
    return serverError(res, err);
  }
});

module.exports = router;
