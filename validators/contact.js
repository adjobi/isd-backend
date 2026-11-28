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
  // Chiffres « keycap » (0️⃣) et sélecteurs de variante : on garde le chiffre seul.
  let s = String(text || "").replace(/[\p{Me}\uFE0E\uFE0F]/gu, "").normalize("NFKC");
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

// ---------- Nombres en lettres (français, anglais, phonétique courante) ----------
const UNITS = {
  zero: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9,
  one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9,
  set: 7, nef: 9, katr: 4, kat: 4, senk: 5, sink: 5, trwa: 3, wit: 8, sis: 6, de: null,
};
delete UNITS.de; // « de » : trop courant, jamais converti
const TEENS = {
  dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16,
  ten: 10, eleven: 11, twelve: 12, di: 10, douz: 12,
};
const TENS = {
  vingt: 20, vingts: 20, vin: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
};
const REPEAT = { double: 2, triple: 3 };
const isNumWord = (w) => w in UNITS || w in TEENS || w in TENS || w === "cent" || w === "hundred";

// Une suite de nombres en lettres → nombres (« vingt-cinq » → 25, « soixante-dix-sept » → 77,
// « quatre-vingt-neuf » → 89, « double zéro » → 0 0).
function parseNumberWords(words) {
  const out = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (w in REPEAT && i + 1 < words.length && words[i + 1] in UNITS) {
      for (let k = 0; k < REPEAT[w]; k += 1) out.push(UNITS[words[i + 1]]);
      i += 2;
    } else if (w in TENS || (w === "quatre" && /^vingts?$/.test(words[i + 1] || ""))) {
      let v = w === "quatre" ? 80 : TENS[w];
      i += w === "quatre" ? 2 : 1;
      if (words[i] === "et" && (words[i + 1] === "un" || words[i + 1] === "onze")) i += 1;
      if ((v === 60 || v === 80) && words[i] in TEENS) {
        v += TEENS[words[i]];
        i += 1;
        if (v % 10 === 0 && ["sept", "huit", "neuf", "set", "wit", "nef"].includes(words[i])) { v += UNITS[words[i]]; i += 1; }
      } else if (words[i] in UNITS && UNITS[words[i]] > 0) {
        v += UNITS[words[i]];
        i += 1;
      }
      out.push(v);
    } else if (w in TEENS) {
      let v = TEENS[w];
      i += 1;
      if (v === 10 && ["sept", "huit", "neuf", "set", "wit", "nef"].includes(words[i])) { v += UNITS[words[i]]; i += 1; }
      out.push(v);
    } else if (w in UNITS) {
      out.push(UNITS[w]);
      i += 1;
    } else if (w === "cent" || w === "hundred") {
      out.push(100);
      i += 1;
    } else {
      i += 1; // « et », « double » seul
    }
  }
  return out;
}

// Remplace chaque suite de nombres en lettres par ses chiffres ; renvoie aussi le plus long
// enchaînement de mots-nombres (indice fort d'un numéro dicté).
function wordsToDigits(s) {
  const tokens = s.match(/[a-z]+|[^a-z]+/g) || [];
  let out = "";
  let run = [];
  let pending = ""; // séparateurs entre deux mots d'une même suite
  let longest = 0;
  const flush = () => {
    if (run.some(isNumWord)) {
      longest = Math.max(longest, run.filter(isNumWord).length);
      out += ` ${parseNumberWords(run).join(" ")} `;
    } else out += run.join(" ");
    run = [];
  };
  for (const t of tokens) {
    const isWord = /^[a-z]+$/.test(t);
    if (isWord && (isNumWord(t) || t in REPEAT || (t === "et" && run.length))) {
      if (!run.length) out += pending;
      pending = "";
      run.push(t);
    } else if (!isWord && run.length && /^[\s,.\-]*$/.test(t)) {
      pending = t;
    } else {
      if (run.length) flush();
      out += pending + t;
      pending = "";
    }
  }
  if (run.length) flush();
  out += pending;
  return { text: out, longest };
}

// ---------- Regroupement des chiffres ----------
// Texte réduit aux chiffres utiles : dates, heures et montants sont neutralisés (ils ne forment
// jamais un numéro), symboles et emojis deviennent des espaces.
const BREAK = " # ";
function digitText(s) {
  let t = s.replace(/[\p{So}\p{Sk}\p{Extended_Pictographic}\p{Co}]/gu, " ");
  // Dates : 12/05/1995, 01-12-2026, 12/05
  t = t.replace(/(?<!\d)\d{1,2}[/.-]\d{1,2}(?:[/.-](?:19|20)?\d{2})?(?![\d/.-]?\d)/g, BREAK);
  // Heures : 7h, 7h30, 18 h, 12:30 (pas « 07h09h10… »)
  t = t.replace(/(?<!\d[a-z]?)\b(?:[01]?\d|2[0-3])\s?(?:h|:)\s?(?:[0-5]\d)?(?![a-z:]?\s?\d)/g, BREAK);
  // Montants : 60 000, 75.000, 70000, 50 000 FCFA, 30 mille
  t = t.replace(/(?<!\d)\d{1,3}(?:[\s.]\d{3})+(?![\d])/g, BREAK);
  t = t.replace(/(?<!\d)\d+000(?!\d)/g, BREAK);
  t = t.replace(/(?<!\d)\d+\s*(?:fcfa|f cfa|cfa|francs?|mille|k)\b/g, BREAK);
  return t;
}

// Groupes de chiffres séparés par de courts intervalles (≤ 6 caractères visibles :
// « 07 et 09 », « 07a09 », « 07 - - - - 09 », espaces multiples).
const GAP_MAX = 6;
function digitGroups(t) {
  const groups = [];
  const re = /\d+|[^\d]+/g;
  let cur = "";
  let m;
  while ((m = re.exec(t))) {
    const part = m[0];
    if (/^\d/.test(part)) cur += part;
    else if (part.includes("#") || part.replace(/\s/g, "").length > GAP_MAX) {
      if (cur) groups.push(cur);
      cur = "";
    }
  }
  if (cur) groups.push(cur);
  return groups;
}

// Formes des numéros ivoiriens : mobiles 01/05/07 et fixes 21/25/27, 10 chiffres, indicatif 225 facultatif.
const IVORIAN = /(?:225)?0[157]\d{8}|(?:225)?2[157]\d{8}/g;
function ivorianNumbers(digits) {
  return digits.match(IVORIAN) || [];
}
const isAllowed = (number, allowPhones) => allowPhones.some((p) => {
  const core = number.replace(/^225(?=\d{10}$)/, "");
  return core === p.slice(-10) || number === p;
});

function hasPhoneNumber(s, allowPhones) {
  const words = wordsToDigits(s).text;
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
    // Chiffres éparpillés (lettres, mots, emojis, longs séparateurs entre eux)
    for (const g of digitGroups(digitText(v))) {
      if (ivorianNumbers(g).some((n) => !isAllowed(n, allowPhones))) return true;
    }
  }
  return false;
}

// Chiffres d'un message, pour la mémoire entre messages (numéro dicté en plusieurs fois).
function messageDigits(text) {
  const s = normalize(text);
  const words = wordsToDigits(s).text.replace(/[0-9oil|]*\d[0-9oil|]*/g, (tok) => tok.replace(/o/g, "0").replace(/[il|]/g, "1"));
  return digitGroups(digitText(words)).join("");
}

// Un numéro reconstitué à partir des derniers fragments (dont celui du message courant) ?
// fragments : chaînes de chiffres, du plus ancien au plus récent ; la dernière est le message courant.
function phoneAcrossMessages(fragments, { allowPhones = [] } = {}) {
  const list = fragments.filter(Boolean);
  if (list.length < 2) return false;
  const current = list[list.length - 1];
  const joined = list.join("");
  const before = joined.slice(0, joined.length - current.length);
  const found = ivorianNumbers(joined).filter((n) => !isAllowed(n, allowPhones));
  if (!found.length) return false;
  // Le numéro doit utiliser le message courant (sinon il a déjà été traité).
  return ivorianNumbers(before).length < found.length || !before.includes(found[found.length - 1]);
}

// Intention de partager ses coordonnées, sans coordonnée : signalée, jamais bloquée.
const INTENT = /\b(?:(?:mon|ma|notre|ton|ta|votre|ses?|son)\s+(?:numero|num|tel|telephone|portable|contact|mail|e-?mail|adresse mail)|(?:appelle|appel|appelez|bipe|bipez|biper|contacte|contactez|joins|joignez|ecris|ecrivez|texte|sms)[- ]?(?:moi|nous)|donne(?:[- ]moi)?\s+ton\s+(?:numero|num|contact|tel))\b/;
const hasContactIntent = (text) => INTENT.test(normalize(text));

// Mots-clés longs : tolèrent 2 séparateurs entre les lettres, et le « leet » (0→o, 4→a…).
const LONG_KEYWORDS = ["whatsapp", "whatsap", "watsap", "watsapp", "ouatsap", "wassap", "facebook", "messenger", "instagram", "telegram", "snapchat",
  "tiktok", "linkedin", "twitter", "gmail", "yahoo", "hotmail", "outlook", "icloud", "arobase", "protonmail",
  "viber", "skype", "discord", "botim", "wechat", "youtube"];
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", "@": "a", $: "s" };
const SPACED_KEYWORDS = new RegExp(`(?:^|[^a-z])(?:${LONG_KEYWORDS.map((k) => k.split("").join("[^a-z0-9]{0,2}")).join("|")})`);

const PATTERNS = [
  // Numéro écrit entièrement en lettres : au moins 6 nombres à la suite
  new RegExp(`(?:\\b(?:${NUMBER_WORDS})(?:[\\s,.\\-]+|$)){6,}`),
  // Email, y compris déguisé : « jean (at) gmail (dot) com », « jean arobase … point com »
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/,
  /[a-z0-9._-]+\s*@\s*[a-z0-9-]+\s*\.\s*[a-z]{2,}\b/,
  /[([{<]\s*(?:at|arobase)\s*[)\]}>]/,
  /\b(?:point|dot)\s*(?:com|ci|fr|net|org)\b/,
  // Liens et noms de domaine
  /(?:https?:\/\/|www\.)/,
  /\b[a-z0-9-]+\.(?:com|ci|net|org|fr|me|io|ly|co|app)\b/,
  // Réseaux sociaux et messageries (abréviations et fautes courantes)
  /\b(?:whats\s*app|whatsap|watsap|ouatsap|wa\.me|wa|facebook|fb|messenger|insta(?:gram)?|ig|tik\s*tok|snap(?:\s*chat)?|telegram|t\.me|signal|imo|linkedin|twitter)\b/,
  /\b(?:wh?ass?app?|wh?atsp|wtsp|wsp|wpp|whatsa|w\.a|viber|skype|discord|botim|we\s*chat|tg|you\s*tube)\b/,
  // Facebook déguisé : « fesse bouc », « face bouk », « fbk », « fcbk », « livre des visages »
  /\b(?:fe(?:ss?e?|ce|s)|fa(?:ce|ss?e?|is))\s*-?\s*b(?:ou|oo|u)(?:c|k|q)\b|\bf(?:c)?bk\b|\blivre\s+des\s+visages\b/,
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
  // Numéro dicté en lettres en partie seulement (« zéro sept zéro neuf dix ») : commence par zéro.
  const w = wordsToDigits(s);
  if (w.longest >= 4 && digitGroups(digitText(w.text)).some((g) => /^0[1-9]\d{4,}/.test(g))) return true;
  if (PATTERNS.some((re) => re.test(s))) return true;
  const leet = s.replace(/[0134578@$]/g, (c) => LEET[c]);
  return SPACED_KEYWORDS.test(s) || SPACED_KEYWORDS.test(leet);
}

module.exports = { containsChatContact, normalize, messageDigits, phoneAcrossMessages, hasContactIntent };
