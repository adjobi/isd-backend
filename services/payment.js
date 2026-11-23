// Facture ISD, paiement, récapitulatif des engagements et garantie de remplacement.
const crypto = require("crypto");
const Invoice = require("../models/Invoice");
const Contract = require("../models/Contract");
const Offer = require("../models/Offer");
const User = require("../models/User");
const { ChatSession } = require("../models/Chat");
const chat = require("./chat");
const { getPricing, computeFee } = require("./pricing");
const { COMMITMENTS } = require("./engagement");

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans 0/O ni 1/I
const newReference = () => `ISD-${Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join("")}`;
const formatFCFA = (n) => `${Number(n).toLocaleString("fr-FR")} FCFA`;
const idOf = chat.idOf;

// Crée la facture d'une offre conclue dont la date de début est convenue (idempotent).
// Offre de remplacement (garantie) : facture offerte, réglée immédiatement.
async function ensureInvoice(session, io) {
  const existing = await Invoice.findOne({ offerId: session.offerId });
  if (existing) return existing;
  const offer = await Offer.findById(session.offerId);
  if (!offer) return null;
  const provider = await User.findById(session.providerId).select("pricingType").lean();
  const pricing = await getPricing();
  const fee = computeFee({
    agreedPrice: offer.agreedPrice || offer.price,
    unit: provider?.pricingType || "month",
    duration: offer.duration,
    waived: !!offer.feeWaived,
  }, pricing);
  const { amount, ...breakdown } = fee;

  let invoice;
  for (let attempt = 0; attempt < 3 && !invoice; attempt += 1) {
    try {
      invoice = await Invoice.create({
        offerId: offer._id, family: session.familyId, provider: session.providerId,
        reference: newReference(), breakdown, amount, startDate: session.startDate,
        status: amount === 0 ? "waived" : "pending",
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      const again = await Invoice.findOne({ offerId: session.offerId });
      if (again) return again; // créée en parallèle ; sinon : collision de référence, on réessaie
    }
  }
  if (!invoice) throw new Error("Création de facture impossible");

  if (invoice.status === "waived") {
    await markPaid(invoice, { method: "waived", io });
    return invoice;
  }
  const msg = await chat.systemMessage(session,
    `🧾 Facture ISD : ${formatFCFA(invoice.amount)} (référence ${invoice.reference}).\n\nElle est réglée une seule fois par la famille. Dès le paiement confirmé, les coordonnées et le récapitulatif de vos engagements sont disponibles pour les deux parties.`,
    { type: "invoice", meta: { kind: "invoice", amount: invoice.amount, reference: invoice.reference } });
  chat.emitMessage(io, msg);
  await chat.notify(session.familyId, "Facture ISD disponible", `Montant : ${formatFCFA(invoice.amount)}. Réglez-la pour obtenir les coordonnées du prestataire.`, session.offerId);
  return invoice;
}

// Termes du récapitulatif (figés au paiement) ; le préavis est choisi ensuite par les deux parties.
async function buildTerms(invoice, offer) {
  const [family, provider] = await Promise.all([
    User.findById(invoice.family).select("firstName lastName city commune").lean(),
    User.findById(invoice.provider).select("firstName lastName role pricingType").lean(),
  ]);
  return {
    family: { firstName: family?.firstName, lastName: family?.lastName, city: family?.city, commune: family?.commune },
    provider: { firstName: provider?.firstName, lastName: provider?.lastName, role: provider?.role },
    serviceType: offer?.serviceType,
    description: offer?.description,
    city: offer?.city,
    subjects: offer?.subjects || [],
    duration: offer?.duration,
    agreedPrice: offer?.agreedPrice || offer?.price || 0,
    unit: invoice.breakdown?.unit || provider?.pricingType || "month",
    startDate: invoice.startDate,
    fee: invoice.amount,
    reference: invoice.reference,
    guaranteeUntil: invoice.guaranteeUntil,
    noticeDays: null,
    commitments: COMMITMENTS,
  };
}

// Récapitulatif d'une facture réglée (idempotent).
async function ensureContract(invoice, offerDoc) {
  const existing = await Contract.findOne({ offerId: invoice.offerId });
  if (existing) return existing;
  const offer = offerDoc || await Offer.findById(invoice.offerId);
  try {
    return await Contract.create({ offerId: invoice.offerId, invoiceId: invoice._id, family: invoice.family, provider: invoice.provider, terms: await buildTerms(invoice, offer) });
  } catch (err) {
    if (err?.code === 11000) return Contract.findOne({ offerId: invoice.offerId });
    throw err;
  }
}

// Facture réglée : coordonnées débloquées, récapitulatif créé, chat et parties prévenus. Idempotent.
async function markPaid(invoice, { method, by = null, io = null } = {}) {
  if (invoice.status === "paid") return invoice;
  const pricing = await getPricing();
  const now = new Date();
  const start = invoice.startDate && invoice.startDate > now ? invoice.startDate : now;
  invoice.status = "paid";
  invoice.method = method;
  invoice.paidAt = now;
  invoice.verifiedBy = by;
  invoice.verifiedAt = by ? now : null;
  invoice.rejectReason = null;
  invoice.guaranteeUntil = new Date(start.getTime() + pricing.guaranteeDays * 86400000);
  await invoice.save();

  // La facture est réglée : les étapes suivantes ne doivent jamais l'annuler.
  // En cas d'échec, le récapitulatif est recréé à la première consultation (ensureContract).
  try {
    const offer = await Offer.findById(invoice.offerId);
    if (offer) { offer.paidAt = now; await offer.save(); }
    await ensureContract(invoice, offer);
  } catch (err) {
    console.error("après paiement (offre / récapitulatif)", err);
  }

  const session = await ChatSession.findOne({ offerId: invoice.offerId }).catch(() => null);
  if (session) {
    session.isPaid = true;
    session.infoRevealed = true;
    if (session.status !== "closed") session.status = "paid";
    await session.save();
    const msg = await chat.systemMessage(session,
      method === "waived"
        ? "✅ Mise en relation offerte au titre de la garantie de remplacement. Les coordonnées sont disponibles dans « Mission ». Confirmez-y ensemble vos engagements et la durée du préavis."
        : "✅ Facture ISD réglée, merci ! Les coordonnées sont maintenant disponibles dans « Mission ».\n\nDernière étape : confirmez-y chacun le récapitulatif de vos engagements, avec la durée de préavis que vous convenez ensemble. Bonne collaboration !",
      { meta: { kind: "paid" } });
    chat.emitMessage(io, msg);
    chat.emitSession(io, session);
  }
  for (const userId of [invoice.family, invoice.provider]) {
    await chat.notify(userId, "Mise en relation confirmée ✅", "Coordonnées disponibles. Confirmez maintenant vos engagements dans « Mission ».", invoice.offerId);
  }
  return invoice;
}

// Rôle de l'utilisateur sur une facture.
const invoiceRole = (invoice, userId) => {
  if (!invoice) return null;
  if (idOf(invoice.family) === String(userId)) return "family";
  if (idOf(invoice.provider) === String(userId)) return "provider";
  return null;
};

module.exports = { ensureInvoice, ensureContract, markPaid, buildTerms, invoiceRole, newReference, formatFCFA };
