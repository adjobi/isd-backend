// Détection des coordonnées (chat, avis, paiements, profils publics, réponses de l'équipe ISD).
// Les coordonnées ne sont partagées qu'après paiement de la facture ISD.
//
// Le texte est d'abord NORMALISÉ pour déjouer les contournements :
//   chiffres Unicode (pleine chasse, arabes…) et lettres stylisées → ASCII
//   caractères invisibles (zéro-largeur…) et accents → supprimés
//   lettres cyrilliques/grecques qui imitent des lettres latines → latin
//   nombres en lettres → chiffres (numéros mélangés « zéro sept 09 dix… »)
//   lettres déguisées en chiffres dans un numéro (« O7 O9 1O… »)
//   chiffres déguisés en lettres dans un mot-clé (« faceb00k », « wh4tsapp »)
//   mots-clés épelés ou coupés (« w h a t s a p p », « face-book », « g.mail »)
// Dates, prix, âges et horaires doivent toujours passer : dans le chat, un faux positif
// compte comme un avertissement (fermeture au 3e).

const NUMBER_WORDS = "zero|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante|soixante|cent";
const WORD_DIGITS = {
  zero: "0", un: "1", une: "1", deux: "2", trois: "3", quatre: "4", cinq: "5", six: "6", sept: "7", huit: "8", neuf: "9",
  dix: "10", onze: "11", douze: "12", treize: "13", quatorze: "14", quinze: "15", seize: "16",
  vingt: "20", trente: "30", quarante: "40", cinquante: "50", soixante: "60", cent: "100",
};

// Lettres d'autres alphabets visuellement identiques à des lettres latines.
const HOMOGLYPHS = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", ԛ: "q", ԝ: "w",
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ω: "w",
};

// Valeur d'un chiffre Unicode : les blocs de chiffres font 10 caractères consécutifs commençant par 0.
function digitValue(ch) {
  const cp = ch.codePointAt(0);
  let zero = cp;
  while (cp - zero < 9 && /\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero -= 1;
  return String(cp - zero);
}

function normalize(text) {
  let s = String(text || "").normalize("NFKC");
  s = s.replace(/\p{Nd}/gu, (d) => (/[0-9]/.test(d) ? d : digitValue(d)));
  s = s.replace(/[\p{Cf}͏ᅟᅠㅤﾠ]/gu, ""); // caractères invisibles
  s = s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase(); // accents
  s = s.replace(/./gu, (c) => HOMOGLYPHS[c] || c);
  s = s.replace(/[‐-―−]/g, "-").replace(/[‘’ʼ]/g, "'");
  return s;
}

// Numéro : chiffres séparés par au plus 3 séparateurs (espaces, points, tirets, barres, parenthèses…).
// La virgule ne compte que collée (« 07,09,… ») pour laisser passer « 60 000, 70 000 ».
const SEP = String.raw`(?:[\s.\-_\/\\()\[\]{}|+*#~'"=]|,(?!\s))`;
const DIGIT_RUN = new RegExp(String.raw`\+?\d(?:${SEP}{0,3}\d)+`, "g");
const DATE_ONLY = /^\d{1,2}[/.-]\d{1,2}[/.-](?:19|20)\d{2}$/;

function hasPhoneNumber(s, allowPhones) {
  const words = s.replace(new RegExp(`\\b(${NUMBER_WORDS})\\b`, "g"), (w) => ` ${WORD_DIGITS[w]} `);
  // Dans une suite qui contient déjà un chiffre : o → 0, i / l / | → 1.
  const variants = [s, words].map((v) => v.replace(/[0-9oil|]*\d[0-9oil|]*/g, (tok) => tok.replace(/o/g, "0").replace(/[il|]/g, "1")));
  for (const v of variants) {
    for (const m of v.match(DIGIT_RUN) || []) {
      const digits = m.replace(/\D/g, "");
      if (digits.length < 8) continue;
      if (digits.length === 8 && DATE_ONLY.test(m)) continue;
      if (allowPhones.some((p) => digits === p || digits === p.slice(-10) || digits === `00${p}`)) continue;
      return true;
    }
  }
  return false;
}

// Mots-clés longs : tolèrent 2 séparateurs entre les lettres, et le « leet » (0→o, 4→a…).
const LONG_KEYWORDS = ["whatsapp", "whatsap", "watsap", "watsapp", "ouatsap", "facebook", "messenger", "instagram", "telegram", "snapchat",
  "tiktok", "linkedin", "twitter", "gmail", "yahoo", "hotmail", "outlook", "icloud", "arobase", "protonmail"];
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", "@": "a", $: "s" };
const SPACED_KEYWORDS = new RegExp(`(?:^|[^a-z])(?:${LONG_KEYWORDS.map((k) => k.split("").join("[^a-z0-9]{0,2}")).join("|")})`);

const PATTERNS = [
  // Numéro écrit entièrement en lettres : au moins 6 nombres à la suite
  new RegExp(`(?:\\b(?:${NUMBER_WORDS})(?:[\\s,.\\-]+|$)){6,}`),
  // Email, y compris déguisé : « jean (at) gmail (dot) com », « jean arobase … point com »
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/,
  /[([{<]\s*(?:at|arobase)\s*[)\]}>]/,
  /\b(?:point|dot)\s*(?:com|ci|fr|net|org)\b/,
  // Liens et noms de domaine
  /(?:https?:\/\/|www\.)/,
  /\b[a-z0-9-]+\.(?:com|ci|net|org|fr|me|io|ly|co|app)\b/,
  // Réseaux sociaux et messageries (abréviations et fautes courantes)
  /\b(?:whats\s*app|whatsap|watsap|ouatsap|wa\.me|wa|facebook|fb|messenger|insta(?:gram)?|ig|tik\s*tok|snap(?:\s*chat)?|telegram|t\.me|signal|imo|linkedin|twitter)\b/,
  // Pseudo @...
  /(?:^|\s)@[a-z0-9_.]{3,}/,
];

// Options (réponses de l'équipe ISD) : les coordonnées d'ISD elle-même restent autorisées.
//   allowPhones : numéros au format international sans « + » (ex. "2250709102524")
//   allowEmails : adresses email
//   allowIsdWhatsapp : « notre WhatsApp », « le WhatsApp d'ISD »
function containsChatContact(text, { allowPhones = [], allowEmails = [], allowIsdWhatsapp = false } = {}) {
  let s = normalize(text);
  for (const e of allowEmails) if (e) s = s.split(normalize(e)).join(" ");
  if (allowIsdWhatsapp) {
    s = s.replace(/\b(?:notre|nos|le|au|sur|via)\s+whats\s*app\s+(?:de\s+l'equipe\s+|d'|de\s+)?isd\b|\bnotre\s+whats\s*app\b|\bwhats\s*app\s+isd\b/g, " ");
  }
  if (hasPhoneNumber(s, allowPhones.filter(Boolean))) return true;
  if (PATTERNS.some((re) => re.test(s))) return true;
  const leet = s.replace(/[0134578@$]/g, (c) => LEET[c]);
  return SPACED_KEYWORDS.test(s) || SPACED_KEYWORDS.test(leet);
}

module.exports = { containsChatContact, normalize };
