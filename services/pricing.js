// Tarifs ISD : frais de mise en relation payés une fois par la famille.
// Valeurs par défaut ci-dessous, modifiables par un administrateur (collection settings, clé "pricing").
const Setting = require("../models/Setting");

const DEFAULT_PRICING = {
  rate: 0.2, // 20 % du premier mois
  minFee: 3000, // FCFA
  shortFlat: 3000, // mission courte / ponctuelle : forfait
  launchDiscount: 0.5, // offre de lancement : -50 %
  launchUntil: "2027-02-28", // inclus ; null = pas d'offre
  guaranteeDays: 30,
  // Estimation d'un mois à partir de l'unité du tarif convenu
  monthlyFactor: { month: 1, day: 20, session: 8, hour: 16 }, // heure : ~4 h par semaine
};

const round100 = (n) => Math.round(n / 100) * 100;

async function getPricing() {
  try {
    const doc = await Setting.findOne({ key: "pricing" }).lean();
    const v = doc?.value || {};
    return { ...DEFAULT_PRICING, ...v, monthlyFactor: { ...DEFAULT_PRICING.monthlyFactor, ...(v.monthlyFactor || {}) } };
  } catch {
    return { ...DEFAULT_PRICING };
  }
}

const launchActive = (pricing, now = new Date()) =>
  !!pricing.launchUntil && pricing.launchDiscount > 0 && now <= new Date(`${pricing.launchUntil}T23:59:59.999Z`);

// Calcule le montant de la facture et son détail.
function computeFee({ agreedPrice, unit, duration, waived }, pricing, now = new Date()) {
  const price = Number(agreedPrice) || 0;
  const u = pricing.monthlyFactor[unit] ? unit : "month";
  if (waived) {
    return { agreedPrice: price, unit: u, monthlyEstimate: 0, rate: 0, kind: "waived", baseFee: 0, discount: 0, discountLabel: "Garantie de remplacement", amount: 0 };
  }
  let kind;
  let baseFee;
  let monthlyEstimate = 0;
  if (duration === "short") {
    kind = "flat";
    baseFee = pricing.shortFlat;
  } else {
    kind = "percent";
    monthlyEstimate = price * pricing.monthlyFactor[u];
    baseFee = Math.max(pricing.minFee, round100(monthlyEstimate * pricing.rate));
  }
  const discount = launchActive(pricing, now) ? round100(baseFee * pricing.launchDiscount) : 0;
  return {
    agreedPrice: price, unit: u, monthlyEstimate, rate: kind === "percent" ? pricing.rate : 0, kind, baseFee,
    discount, discountLabel: discount ? `Offre de lancement -${Math.round(pricing.launchDiscount * 100)} %` : null,
    amount: Math.max(0, baseFee - discount),
  };
}

// Validation des réglages saisis par un administrateur (pourcentages en %).
function validatePricing(body) {
  const errors = {};
  const v = {};
  const num = (k, min, max, label) => {
    const x = body?.[k];
    if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max) errors[k] = `${label} : entre ${min} et ${max}`;
    return x;
  };
  const ratePct = num("ratePercent", 1, 50, "Commission (%)");
  const minFee = num("minFee", 0, 100000, "Minimum (FCFA)");
  const shortFlat = num("shortFlat", 0, 100000, "Forfait courte durée (FCFA)");
  const discountPct = num("launchDiscountPercent", 0, 90, "Réduction de lancement (%)");
  const guaranteeDays = num("guaranteeDays", 0, 90, "Garantie (jours)");
  const until = body?.launchUntil;
  if (until !== null && (typeof until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(new Date(until).getTime()))) {
    errors.launchUntil = "Date de fin AAAA-MM-JJ (ou vide)";
  }
  if (Object.keys(errors).length) return { errors };
  v.rate = Math.round(ratePct * 100) / 10000;
  v.minFee = Math.round(minFee);
  v.shortFlat = Math.round(shortFlat);
  v.launchDiscount = Math.round(discountPct * 100) / 10000;
  v.launchUntil = until;
  v.guaranteeDays = Math.round(guaranteeDays);
  return { value: v };
}

module.exports = { DEFAULT_PRICING, getPricing, computeFee, validatePricing, launchActive, round100 };
