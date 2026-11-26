// Mesure d'audience anonyme (pages vues du site et de l'app) et activité quotidienne des comptes.
const crypto = require("crypto");
const Visit = require("../models/Visit");
const UserActivity = require("../models/UserActivity");

const dayOf = (d = new Date()) => d.toISOString().slice(0, 10); // Abidjan = UTC+0

// Sel du jour : aléatoire, en mémoire seulement, renouvelé à minuit. Une empreinte de visiteur
// ne peut donc pas être recalculée ni suivie d'un jour à l'autre.
let salt = { day: "", value: "" };
function dailySalt(day) {
  if (salt.day !== day) salt = { day, value: crypto.randomBytes(16).toString("hex") };
  return salt.value;
}

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp\/|headless|lighthouse|curl|wget|python|axios|node-fetch|go-http/i;

// Origine de la visite : utm_source si présent, sinon le site d'où vient le visiteur.
const SOURCES = [
  ["google", /google\./], ["facebook", /facebook\.|fb\.|messenger\./], ["whatsapp", /whatsapp\.|wa\.me/],
  ["instagram", /instagram\./], ["tiktok", /tiktok\./], ["linkedin", /linkedin\.|lnkd\.in/],
  ["bing", /bing\./], ["youtube", /youtube\.|youtu\.be/], ["x", /(^|\.)x\.com|twitter\.|t\.co$/],
];
function sourceOf({ utm, ref, host }) {
  const u = String(utm || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
  if (u) return u;
  let h = "";
  try { h = new URL(String(ref || "")).hostname.toLowerCase(); } catch { return "direct"; }
  if (!h || (host && h === String(host).toLowerCase())) return "direct";
  const hit = SOURCES.find(([, re]) => re.test(h));
  return hit ? hit[0] : "autre";
}

// Chemin nettoyé : pas de paramètres (ils peuvent contenir des données), longueur limitée.
const cleanPath = (p) => {
  const s = String(p || "/").split(/[?#]/)[0].replace(/[^\w\-/.~%]/g, "");
  return (s.startsWith("/") ? s : `/${s}`).slice(0, 120);
};

// Enregistre une page vue. Renvoie false si ignorée (robot, données invalides).
async function recordVisit({ body, ip, ua, host, now = new Date() }) {
  if (!ua || BOT.test(ua)) return false;
  const kind = body?.kind === "app" ? "app" : body?.kind === "site" ? "site" : null;
  if (!kind) return false;
  const day = dayOf(now);
  const visitor = crypto.createHash("sha256").update(`${dailySalt(day)}|${ip}|${ua}`).digest("hex").slice(0, 16);
  const platform = ["android", "ios"].includes(body?.platform) ? body.platform : "web";
  const device = platform !== "web" || /mobi|android|iphone|ipad/i.test(ua) ? "mobile" : "desktop";
  await Visit.create({ kind, path: cleanPath(body?.path), source: sourceOf({ utm: body?.utm, ref: body?.ref, host }), device, platform, visitor, day });
  return true;
}

// Activité des comptes : au plus une écriture par compte et par jour (mémoire du processus).
const seen = new Set();
let seenDay = "";
function touchUser(token) {
  if (!token?.id || token.team || !["family", "nanny", "tutor"].includes(token.role)) return;
  const now = new Date();
  const day = dayOf(now);
  if (day !== seenDay) { seen.clear(); seenDay = day; }
  const key = String(token.id);
  if (seen.has(key)) return;
  seen.add(key);
  UserActivity.updateOne(
    { user: token.id, day },
    { $setOnInsert: { user: token.id, day, role: token.role, at: now } },
    { upsert: true }
  ).catch(() => seen.delete(key)); // base indisponible : on réessaiera à la prochaine requête
}

module.exports = { recordVisit, touchUser, sourceOf, cleanPath, dayOf, BOT };
