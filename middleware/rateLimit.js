// Limiteur simple par adresse IP (fenêtre fixe, en mémoire).
// Utilisé pour les routes publiques sensibles (ex. inscription).
module.exports = function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.until <= now) hits.delete(k);
  }, windowMs).unref();
  const limiter = (req, res, next) => {
    const now = Date.now();
    const key = req.ip || "inconnue";
    const cur = hits.get(key);
    if (!cur || cur.until <= now) {
      hits.set(key, { count: 1, until: now + windowMs });
      return next();
    }
    cur.count += 1;
    if (cur.count > max) {
      res.set("Retry-After", String(Math.ceil((cur.until - now) / 1000)));
      return res.status(429).json({ message });
    }
    return next();
  };
  limiter.reset = () => hits.clear();
  return limiter;
};
