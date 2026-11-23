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
const chat = require("../services/chat");
const payment = require("../services/payment");
const { getPricing, validatePricing, launchActive } = require("../services/pricing");

const STATUSES = ["submitted", "pending", "paid", "rejected", "waived"];

router.use(auth, adminOnly);

router.param("invoiceId", (req, res, next, id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Identifiant invalide" });
  return next();
});

const serverError = (res, err) => {
  console.error("admin", err);
  return res.status(500).json({ message: "Erreur serveur. Réessayez dans un instant." });
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
    await Setting.findOneAndUpdate({ key: "pricing" }, { $set: { value, updatedBy: req.user.id } }, { upsert: true, new: true });
    return res.json(pricingView(await getPricing()));
  } catch (err) {
    return serverError(res, err);
  }
});

module.exports = router;
