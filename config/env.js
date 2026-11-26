// Vérification de la configuration au démarrage.
// En production (NODE_ENV=production), le serveur refuse de démarrer avec une configuration
// dangereuse : clé secrète courte, origines CORS non restreintes, clé de chiffrement absente…
const isProd = () => process.env.NODE_ENV === "production";

// Origines autorisées à appeler l'API depuis un navigateur (le site web).
// CORS_ORIGINS="https://isd.ci,https://www.isd.ci" ; en développement, tout est autorisé.
function corsOrigins() {
  const list = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : (isProd() ? [] : "*");
}

function checkEnv() {
  const problems = [];
  if (!process.env.MONGO_URI) problems.push("MONGO_URI manquant");
  if (!process.env.JWT_SECRET) problems.push("JWT_SECRET manquant");
  if (!/^[0-9a-fA-F]{64}$/.test(process.env.CHAT_ENCRYPTION_KEY || "")) {
    problems.push("CHAT_ENCRYPTION_KEY doit faire 64 caractères hexadécimaux");
  }
  const idKey = process.env.IDENTITY_ENCRYPTION_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(idKey)) {
    problems.push("IDENTITY_ENCRYPTION_KEY doit faire 64 caractères hexadécimaux");
  } else if (idKey.toLowerCase() === String(process.env.CHAT_ENCRYPTION_KEY || "").toLowerCase()) {
    problems.push("IDENTITY_ENCRYPTION_KEY doit être différente de CHAT_ENCRYPTION_KEY");
  }
  if (isProd()) {
    if ((process.env.JWT_SECRET || "").length < 64) problems.push("JWT_SECRET doit faire au moins 64 caractères en production");
    if (!corsOrigins().length) problems.push("CORS_ORIGINS doit lister le(s) domaine(s) du site en production");
    if (!process.env.ISD_MOBILE_MONEY_NUMBER) problems.push("ISD_MOBILE_MONEY_NUMBER manquant");
  }
  return problems;
}

module.exports = { checkEnv, corsOrigins, isProd };
