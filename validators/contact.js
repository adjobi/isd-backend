// Détection des coordonnées dans le chat (plus stricte que pour les profils).
// Les coordonnées ne sont partagées qu'après paiement de la facture ISD.

const NUMBER_WORDS = "zéro|zero|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante|soixante|cent";

const CHAT_CONTACT_PATTERNS = [
  // Numéros : 8 chiffres ou plus, séparés ou non (espaces, points, tirets) — les dates « 01/12/2026 » passent.
  /(?:\+?\d[\s.\-_]{0,3}){8,}/,
  // Numéro écrit en lettres : au moins 6 nombres à la suite
  new RegExp(`(?:\\b(?:${NUMBER_WORDS})(?:[\\s,.\\-]+|$)){6,}`, "i"),
  // Email, y compris déguisé
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,
  /\b(?:arobase|at\s+gmail|gmail|yahoo|hotmail|outlook|icloud)\b/i,
  /\bpoint\s*(?:com|ci|fr|net|org)\b/i,
  // Liens et noms de domaine
  /(?:https?:\/\/|www\.)/i,
  /\b[a-z0-9-]+\.(?:com|ci|net|org|fr|me|io|ly|co|app)\b/i,
  // Réseaux sociaux et messageries (y compris abréviations et fautes courantes)
  /\b(?:whats\s*app|whatsap|watsap|ouatsap|wa\.me|wa|facebook|fb|messenger|insta(?:gram)?|ig|tik\s*tok|snap(?:\s*chat)?|telegram|t\.me|signal|imo|linkedin|twitter)\b/i,
  // Pseudo @...
  /(?:^|\s)@[a-z0-9_.]{3,}/i,
];

const containsChatContact = (text) => CHAT_CONTACT_PATTERNS.some((re) => re.test(String(text || "")));

module.exports = { containsChatContact };
