const User = require("../models/User");

// Champs publics d'un prestataire. Liste fermée : téléphone, email, mot de passe
// et tout autre champ interne ne sortent jamais par cette route.
const PUBLIC_PROVIDER_FIELDS = [
  "firstName", "lastName", "role", "serviceType",
  "city", "commune", "photo", "bio", "values", "skills",
  "subjects", "pricingType", "pricingAmount",
  "availability", "rating", "isVerified", "createdAt",
].join(" ");

const PROVIDER_TYPES = ["nanny", "tutor"];
const AVAILABILITIES = ["available", "busy", "away"];
const MAX_TEXT = 60;
const MAX_LIMIT = 50;

// Échappe les caractères spéciaux d'une expression régulière (évite injection / ReDoS).
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Un paramètre de requête doit être une chaîne simple : Express (qs) transforme
// ?type[$ne]=x en objet, ce qui permettrait une injection d'opérateur MongoDB.
const readString = (value) => (typeof value === "string" ? value.trim() : undefined);

const readNumber = (value) => {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value.trim())) return NaN;
  return Number(value);
};

exports.getNannies = async (req, res) => {
  try {
    const q = req.query;
    const errors = {};

    const city = readString(q.city);
    if (!city) errors.city = "Veuillez indiquer une ville pour lancer la recherche";
    else if (city.length > MAX_TEXT) errors.city = "Ville trop longue";

    const type = q.type === undefined || q.type === "" ? undefined : readString(q.type);
    if (q.type !== undefined && q.type !== "" && !PROVIDER_TYPES.includes(type)) {
      errors.type = "Type de prestataire invalide";
    }

    const subject = q.subject === undefined || q.subject === "" ? undefined : readString(q.subject);
    if (q.subject !== undefined && q.subject !== "" && (!subject || subject.length > MAX_TEXT)) {
      errors.subject = "Matière invalide";
    }

    const availability = q.availability === undefined || q.availability === "" ? undefined : readString(q.availability);
    if (q.availability !== undefined && q.availability !== "" && !AVAILABILITIES.includes(availability)) {
      errors.availability = "Disponibilité invalide";
    }

    const minPrice = readNumber(q.minPrice);
    const maxPrice = readNumber(q.maxPrice);
    if (Number.isNaN(minPrice)) errors.minPrice = "Prix minimum invalide";
    if (Number.isNaN(maxPrice)) errors.maxPrice = "Prix maximum invalide";

    const page = readNumber(q.page);
    const limit = readNumber(q.limit);
    if (Number.isNaN(page) || (page !== undefined && (page < 1 || !Number.isInteger(page)))) errors.page = "Page invalide";
    if (Number.isNaN(limit) || (limit !== undefined && (limit < 1 || !Number.isInteger(limit)))) errors.limit = "Limite invalide";

    if (Object.keys(errors).length > 0) {
      const first = Object.values(errors)[0];
      return res.status(400).json({ message: first, errors });
    }

    const filter = {
      role: type ? type : { $in: PROVIDER_TYPES },
      city: { $regex: escapeRegex(city), $options: "i" },
    };
    if (minPrice !== undefined || maxPrice !== undefined) {
      filter.pricingAmount = {};
      if (minPrice !== undefined) filter.pricingAmount.$gte = minPrice;
      if (maxPrice !== undefined) filter.pricingAmount.$lte = maxPrice;
    }
    if (subject) filter.subjects = subject;
    if (availability) filter.availability = availability;

    const perPage = Math.min(limit || 20, MAX_LIMIT);
    const skip = ((page || 1) - 1) * perPage;

    const providers = await User.find(filter)
      .select(PUBLIC_PROVIDER_FIELDS)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .lean();

    return res.json(providers);
  } catch (error) {
    console.error("getNannies:", error);
    return res.status(500).json({ message: "Erreur serveur lors de la recherche" });
  }
};

exports.PUBLIC_PROVIDER_FIELDS = PUBLIC_PROVIDER_FIELDS;
