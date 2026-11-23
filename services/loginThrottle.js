// Limite les tentatives de connexion (contre le forçage de mot de passe).
// - par email : MAX_PER_EMAIL échecs sur la fenêtre → compte bloqué jusqu'à la fin de la fenêtre
// - par adresse IP : MAX_PER_IP tentatives sur la fenêtre (protège contre l'essai de nombreux emails)
// Stockage en mémoire : suffisant pour un seul serveur ; remis à zéro au redémarrage.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 30;

const byEmail = new Map(); // email → { count, until }
const byIp = new Map();

const bump = (map, key, now) => {
  const cur = map.get(key);
  if (!cur || cur.until <= now) {
    map.set(key, { count: 1, until: now + WINDOW_MS });
    return 1;
  }
  cur.count += 1;
  return cur.count;
};

const blockedFor = (map, key, max, now) => {
  const cur = map.get(key);
  if (!cur || cur.until <= now || cur.count < max) return 0;
  return Math.ceil((cur.until - now) / 1000);
};

// À appeler avant de vérifier le mot de passe. Retourne le nombre de secondes d'attente (0 = autorisé).
function check(ip, email, now = Date.now()) {
  return Math.max(blockedFor(byEmail, email, MAX_PER_EMAIL, now), blockedFor(byIp, ip, MAX_PER_IP, now));
}

// Toute tentative compte pour l'IP ; seuls les échecs comptent pour l'email.
function attempt(ip, now = Date.now()) { bump(byIp, ip, now); }
function failure(email, now = Date.now()) { bump(byEmail, email, now); }
function success(email) { byEmail.delete(email); }
function reset() { byEmail.clear(); byIp.clear(); }

// Ménage périodique des entrées expirées.
setInterval(() => {
  const now = Date.now();
  for (const map of [byEmail, byIp]) for (const [k, v] of map) if (v.until <= now) map.delete(k);
}, WINDOW_MS).unref();

module.exports = { check, attempt, failure, success, reset, WINDOW_MS, MAX_PER_EMAIL, MAX_PER_IP };
