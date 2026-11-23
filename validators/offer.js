// Validation des offres et des montants de négociation.
const { containsContact } = require("./profile");

const PRICE_MIN = 500;
const PRICE_MAX = 2000000;
const DESCRIPTION_MIN = 20;
const DESCRIPTION_MAX = 600;
const MESSAGE_MAX = 300;
const MAX_COUNTERS = 3; // contre-propositions par partie et par candidature
const CONTACT_MESSAGE = "Pas de téléphone, email, lien ni réseau social : les coordonnées sont partagées après paiement de la facture ISD.";

const isStr = (v) => typeof v === "string";
const clean = (s) => s.trim().replace(/\s+/g, " ");

// Montant de négociation : entier en FCFA.
function readAmount(v) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < PRICE_MIN || v > PRICE_MAX) {
    return { error: `Montant entre ${PRICE_MIN} et ${PRICE_MAX.toLocaleString("fr-FR")} FCFA` };
  }
  return { value: v };
}

// Message facultatif joint à une candidature.
function readMessage(v) {
  if (v === undefined || v === null || v === "") return { value: "" };
  if (!isStr(v)) return { error: "Message invalide" };
  const s = clean(v);
  if (s.length > MESSAGE_MAX) return { error: `${MESSAGE_MAX} caractères maximum` };
  if (containsContact(s)) return { error: CONTACT_MESSAGE };
  return { value: s };
}

// Création (partial=false) ou modification (partial=true) d'une offre.
function validateOffer(body, { partial = false, serviceType: currentType } = {}) {
  const errors = {};
  const data = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return { data, errors: { body: "Requête invalide" } };
  const has = (k) => body[k] !== undefined && body[k] !== null;

  if (!partial) {
    if (["nanny", "tutor"].includes(body.serviceType)) data.serviceType = body.serviceType;
    else errors.serviceType = "Choisissez une nounou ou un répétiteur";
  }
  const type = data.serviceType || currentType;

  if (!partial || has("description")) {
    if (!isStr(body.description)) errors.description = "Décrivez votre besoin";
    else {
      const d = clean(body.description);
      if (d.length < DESCRIPTION_MIN) errors.description = `${DESCRIPTION_MIN} caractères minimum`;
      else if (d.length > DESCRIPTION_MAX) errors.description = `${DESCRIPTION_MAX} caractères maximum`;
      else if (containsContact(d)) errors.description = CONTACT_MESSAGE;
      else data.description = d;
    }
  }
  if (!partial || has("duration")) {
    if (["short", "long"].includes(body.duration)) data.duration = body.duration;
    else errors.duration = "Choisissez la durée de la mission";
  }
  if (!partial || has("city")) {
    if (!isStr(body.city) || clean(body.city).length < 2 || clean(body.city).length > 60) errors.city = "Indiquez la ville de la mission";
    else if (containsContact(body.city)) errors.city = CONTACT_MESSAGE;
    else data.city = clean(body.city);
  }
  if (has("price")) {
    if (body.price === 0) data.price = 0;
    else {
      const a = readAmount(body.price);
      if (a.error) errors.price = a.error; else data.price = a.value;
    }
  } else if (!partial) data.price = 0;

  if (has("subjects")) {
    const v = body.subjects;
    if (!Array.isArray(v) || !v.every(isStr)) errors.subjects = "Matières invalides";
    else {
      const items = [...new Set(v.map(clean).filter(Boolean))];
      if (type !== "tutor" && items.length) errors.subjects = "Les matières concernent les répétiteurs";
      else if (items.length > 12 || items.some((s) => s.length > 40)) errors.subjects = "Matières invalides";
      else data.subjects = items;
    }
  } else if (!partial) data.subjects = [];

  return { data, errors };
}

module.exports = { validateOffer, readAmount, readMessage, MAX_COUNTERS, PRICE_MIN, PRICE_MAX };
