// Limiteur simple par adresse IP (fenêtre fixe, en mémoire).
// Utilisé pour les routes publiques sensibles (ex. inscription).
module.exports = function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.until <= now) hits.delete(k);
  }, windowMs).unref();
  // Compte un passage ; renvoie 0 si autorisé, sinon le délai d'attente en secondes.
  const hit = (req) => {
    const now = Date.now();
    const key = req.ip || "inconnue";
    const cur = hits.get(key);
    if (!cur || cur.until <= now) {
      hits.set(key, { count: 1, until: now + windowMs });
      return 0;
    }
    cur.count += 1;
    return cur.count > max ? Math.ceil((cur.until - now) / 1000) : 0;
  };
  const limiter = (req, res, next) => {
    const wait = hit(req);
    if (wait) {
      res.set("Retry-After", String(wait));
      return res.status(429).json({ message });
    }
    return next();
  };
  // Pour compter seulement à un point précis d'une route (ex. après authentification et validation).
  limiter.hit = hit;
  limiter.message = message;
  limiter.reset = () => hits.clear();
  return limiter;
};
