// Données publiques du site vitrine (sans compte) : profils anonymisés et chiffres réels.
// Jamais de téléphone, d'email, de nom complet ni de photo : ils restent réservés aux
// familles inscrites, et les coordonnées à la mise en relation payée.
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const { getPricing, launchActive } = require("../services/pricing");
const { containsChatContact } = require("../validators/contact");

const SERVICES = ["nanny", "tutor"];
const publicLimiter = require("../middleware/rateLimit")({ windowMs: 60 * 1000, max: 120, message: "Trop de requêtes. Réessayez dans une minute." });
router.use(publicLimiter);
const MAX_LIMIT = 24;
const CACHE_MS = 60 * 1000;
const cache = new Map();

// Petite mise en cache : la vitrine est la page la plus vue, la base n'a pas à suivre chaque visite.
async function cached(key, compute) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await compute();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}
const clearCache = () => cache.clear();

const clean = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");
const excerpt = (text, max = 160) => {
  const t = clean(text);
  if (!t || containsChatContact(t)) return "";
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : t;
};
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Profil tel que montré au public.
function publicProfile(u) {
  return {
    id: String(u._id),
    firstName: clean(u.firstName).split(" ")[0],
    initial: clean(u.lastName).charAt(0).toUpperCase(),
    serviceType: u.serviceType || (u.role === "tutor" ? "tutor" : "nanny"),
    commune: clean(u.commune),
    city: clean(u.city),
    subjects: (u.subjects || []).slice(0, 4),
    skills: (u.skills || []).filter((s) => !containsChatContact(s)).slice(0, 4),
    pricingType: u.pricingType || null,
    pricingAmount: Number(u.pricingAmount) || null,
    rating: Number(u.rating) || 0,
    available: (u.availability || "available") === "available",
    verified: !!u.isVerified,
    bio: excerpt(u.bio),
    since: u.createdAt,
  };
}

const providerFilter = (service, commune) => {
  const f = { role: { $in: service ? [service] : SERVICES } };
  if (commune) f.commune = new RegExp(`^${escapeRegex(commune)}$`, "i");
  return f;
};

router.get("/providers", async (req, res) => {
  try {
    const service = SERVICES.includes(req.query.service) ? req.query.service : null;
    const commune = clean(req.query.commune).slice(0, 40);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 12));
    const data = await cached(`p:${service}:${commune.toLowerCase()}:${limit}`, async () => {
      const filter = providerFilter(service, commune);
      const [list, total] = await Promise.all([
        User.find(filter)
          .select("firstName lastName role serviceType commune city subjects skills pricingType pricingAmount rating availability isVerified bio createdAt")
          .sort({ isVerified: -1, rating: -1, updatedAt: -1 })
          .limit(limit)
          .lean(),
        User.countDocuments(filter),
      ]);
      return { total, providers: list.map(publicProfile) };
    });
    res.set("Cache-Control", "public, max-age=60");
    return res.json(data);
  } catch (err) {
    console.error("public providers", err);
    return res.status(500).json({ message: "Erreur serveur. Réessayez dans un instant." });
  }
});

// Chiffres réels pour la vitrine : prestataires par service et par commune, tarifs ISD.
router.get("/summary", async (req, res) => {
  try {
    const data = await cached("summary", async () => {
      const [byCommune, pricing] = await Promise.all([
        User.aggregate([
          { $match: { role: { $in: SERVICES } } },
          { $group: { _id: { role: "$role", commune: "$commune" }, n: { $sum: 1 } } },
        ]),
        getPricing(),
      ]);
      const totals = { nanny: 0, tutor: 0 };
      const communes = {};
      for (const row of byCommune) {
        const { role, commune } = row._id;
        totals[role] += row.n;
        const key = clean(commune);
        if (!key) continue;
        communes[key] = communes[key] || { nanny: 0, tutor: 0 };
        communes[key][role] += row.n;
      }
      return {
        totals,
        communes,
        pricing: {
          ratePercent: Math.round((pricing.rate || 0) * 100),
          minFee: pricing.minFee,
          shortFlat: pricing.shortFlat,
          guaranteeDays: pricing.guaranteeDays,
          launch: launchActive(pricing) ? { discountPercent: Math.round(pricing.launchDiscount * 100), until: pricing.launchUntil } : null,
        },
      };
    });
    res.set("Cache-Control", "public, max-age=60");
    return res.json(data);
  } catch (err) {
    console.error("public summary", err);
    return res.status(500).json({ message: "Erreur serveur. Réessayez dans un instant." });
  }
});

module.exports = router;
module.exports.clearCache = clearCache;
module.exports.publicLimiter = publicLimiter;
module.exports.publicProfile = publicProfile;
