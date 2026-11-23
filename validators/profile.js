// Validation de PUT /api/auth/profile.
// Retourne { updates, errors } : seuls les champs autorisés pour le rôle sont repris.

const PHOTO_MAX_BYTES = 300 * 1024;
const BIO_MAX = 600;
const LIST_MAX_ITEMS = 12;
const ITEM_MAX = 40;
const PRICE_MIN = 500;
const PRICE_MAX = 2000000;

const PRICING_BY_ROLE = {
  nanny: ["month", "day", "hour"],
  tutor: ["hour", "session", "day", "month"],
};
const AVAILABILITY = ["available", "busy", "away", "holiday"];

// ---------- Coordonnées cachées dans du texte libre ----------
// Les coordonnées ne sont communiquées qu'après paiement : on refuse
// téléphone, email, liens et réseaux sociaux dans les textes publics.
const CONTACT_PATTERNS = [
  /(?:\+?\d[\s.\-/]?){8,}/,                                      // numéro de téléphone (8 chiffres ou plus)
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,                                 // email
  /(?:https?:\/\/|www\.)/i,                                      // lien
  /\b[a-z0-9-]+\.(?:com|ci|net|org|fr|me|io|ly|co|app)\b/i,      // nom de domaine
  /\b(?:whats\s*app|wa\.me|facebook|fb\.com|instagram|insta|tiktok|snap\s*chat|snap|telegram|t\.me|messenger|linkedin|twitter)\b/i,
  /(?:^|\s)@[a-z0-9_.]{3,}/i,                                    // pseudo @...
];
const containsContact = (text) => CONTACT_PATTERNS.some((re) => re.test(text));
const CONTACT_MESSAGE = "Pas de téléphone, email, lien ni réseau social ici : vos coordonnées sont partagées après paiement de la facture ISD.";

// ---------- Lecteurs ----------
const isStr = (v) => typeof v === "string";

function readText(v, { field, min = 0, max, label, errors, publicText = true }) {
  if (!isStr(v)) { errors[field] = `${label} invalide`; return undefined; }
  const s = v.trim().replace(/\s+/g, " ");
  if (s.length < min) { errors[field] = min === 1 ? `${label} est obligatoire` : `${label} : ${min} caractères minimum`; return undefined; }
  if (s.length > max) { errors[field] = `${label} : ${max} caractères maximum`; return undefined; }
  if (publicText && containsContact(s)) { errors[field] = CONTACT_MESSAGE; return undefined; }
  return s;
}

function readList(v, { field, label, errors }) {
  if (!Array.isArray(v) || !v.every(isStr)) { errors[field] = `${label} invalide`; return undefined; }
  const items = [...new Set(v.map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean))];
  if (items.length > LIST_MAX_ITEMS) { errors[field] = `${LIST_MAX_ITEMS} éléments maximum`; return undefined; }
  if (items.some((s) => s.length > ITEM_MAX)) { errors[field] = `Chaque élément : ${ITEM_MAX} caractères maximum`; return undefined; }
  if (items.some(containsContact)) { errors[field] = CONTACT_MESSAGE; return undefined; }
  return items;
}

const NAME_RE = /^[\p{L}][\p{L}' .-]*$/u;
function readName(v, field, label, errors) {
  const s = readText(v, { field, min: 1, max: 50, label, errors });
  if (s !== undefined && !NAME_RE.test(s)) { errors[field] = `${label} : lettres uniquement`; return undefined; }
  return s;
}

// Numéros ivoiriens : 10 chiffres (01, 05, 07 mobiles ; 21, 25, 27 fixes). Stocké en +225XXXXXXXXXX.
function readPhone(v, errors) {
  if (!isStr(v)) { errors.phone = "Téléphone invalide"; return undefined; }
  let d = v.replace(/[^\d]/g, "");
  if (d.startsWith("00225")) d = d.slice(5);
  else if (d.startsWith("225") && d.length === 13) d = d.slice(3);
  if (!/^(01|05|07|21|25|27)\d{8}$/.test(d)) { errors.phone = "Numéro ivoirien à 10 chiffres (ex : 07 00 00 00 00)"; return undefined; }
  return `+225${d}`;
}

// Photo : "" pour la supprimer, sinon data URI JPEG / PNG, 300 Ko max, contenu vérifié.
function readPhoto(v, errors) {
  if (v === "") return "";
  const m = isStr(v) && /^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if (!m) { errors.photo = "La photo doit être une image JPEG ou PNG"; return undefined; }
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > PHOTO_MAX_BYTES) { errors.photo = "Photo trop lourde (300 Ko maximum)"; return undefined; }
  const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isJpeg && !isPng) { errors.photo = "Le fichier envoyé n’est pas une image valide"; return undefined; }
  return `data:image/${isPng ? "png" : "jpeg"};base64,${m[2]}`;
}

const PROVIDER_ONLY = ["skills", "values", "pricingType", "pricingAmount", "availability"];

function validateProfile(body, role) {
  const errors = {};
  const updates = {};
  const has = (k) => body && Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
  const isProvider = role === "nanny" || role === "tutor";

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { updates, errors: { body: "Requête invalide" } };
  }

  // Champs réservés à un autre rôle : refus explicite plutôt qu'ignorés en silence.
  for (const k of PROVIDER_ONLY) if (!isProvider && has(k)) errors[k] = "Champ non modifiable pour ce profil";
  if (role !== "tutor" && has("subjects")) errors.subjects = "Champ non modifiable pour ce profil";

  if (has("firstName")) updates.firstName = readName(body.firstName, "firstName", "Le prénom", errors);
  if (has("lastName")) updates.lastName = readName(body.lastName, "lastName", "Le nom", errors);
  if (has("phone")) updates.phone = readPhone(body.phone, errors);
  if (has("city")) updates.city = readText(body.city, { field: "city", min: 2, max: 60, label: "La ville", errors });
  if (has("commune")) updates.commune = readText(body.commune, { field: "commune", min: 0, max: 60, label: "La commune", errors });
  if (has("bio")) updates.bio = readText(body.bio, { field: "bio", min: 0, max: BIO_MAX, label: "La présentation", errors });
  if (has("photo")) updates.photo = readPhoto(body.photo, errors);

  if (isProvider) {
    if (has("skills")) updates.skills = readList(body.skills, { field: "skills", label: "Compétences", errors });
    if (has("values")) updates.values = readList(body.values, { field: "values", label: "Valeurs", errors });
    if (has("availability")) {
      if (AVAILABILITY.includes(body.availability)) updates.availability = body.availability;
      else errors.availability = "Disponibilité invalide";
    }
    if (has("pricingType")) {
      if (PRICING_BY_ROLE[role].includes(body.pricingType)) updates.pricingType = body.pricingType;
      else errors.pricingType = "Unité de tarif invalide";
    }
    if (has("pricingAmount")) {
      const n = body.pricingAmount;
      if (typeof n === "number" && Number.isInteger(n) && n >= PRICE_MIN && n <= PRICE_MAX) updates.pricingAmount = n;
      else errors.pricingAmount = `Tarif entre ${PRICE_MIN} et ${PRICE_MAX.toLocaleString("fr-FR")} FCFA`;
    }
  }
  if (role === "tutor" && has("subjects")) {
    updates.subjects = readList(body.subjects, { field: "subjects", label: "Matières", errors });
    if (updates.subjects && updates.subjects.length === 0) errors.subjects = "Indiquez au moins une matière";
  }

  for (const k of Object.keys(updates)) if (updates[k] === undefined) delete updates[k];
  return { updates, errors };
}

module.exports = { validateProfile, containsContact, PHOTO_MAX_BYTES };
