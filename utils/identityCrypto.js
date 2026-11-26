// Chiffrement des images de vérification d'identité (AES-256-GCM, étiquette de 16 octets).
// Clé dédiée : IDENTITY_ENCRYPTION_KEY (64 caractères hexadécimaux), distincte de CHAT_ENCRYPTION_KEY.
// Données associées (AAD) = "<id de la demande>:<champ>" : un chiffré recopié dans une autre
// demande ou dans un autre champ (document ↔ selfie) ne se déchiffre pas.
// Format : "v1.<iv>.<étiquette>.<données>" (base64) ; le préfixe de version permettra une rotation de clé.
const crypto = require("crypto");

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

let warned = false;
function getKey() {
  const hex = process.env.IDENTITY_ENCRYPTION_KEY || "";
  const valid = /^[0-9a-fA-F]{64}$/.test(hex)
    && hex.toLowerCase() !== String(process.env.CHAT_ENCRYPTION_KEY || "").toLowerCase();
  if (valid) return Buffer.from(hex, "hex");
  if (!warned) {
    console.warn("⚠️ IDENTITY_ENCRYPTION_KEY absente, invalide ou identique à CHAT_ENCRYPTION_KEY : vérification d'identité indisponible.");
    warned = true;
  }
  return null;
}

const aad = (checkId, field) => Buffer.from(`${String(checkId)}:${field}`, "utf8");

// Renvoie "v1.iv.tag.données", ou null si aucune clé valide.
function encryptIdentity(text, checkId, field) {
  const key = getKey();
  if (!key) return null;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(checkId, field));
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return [VERSION, ...[iv, cipher.getAuthTag(), data].map((b) => b.toString("base64"))].join(".");
}

// Renvoie le texte, ou null (clé absente, format inconnu, données modifiées ou déplacées).
function decryptIdentity(payload, checkId, field) {
  const key = getKey();
  if (!key || typeof payload !== "string") return null;
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [iv, tag, data] = parts.slice(1).map((p) => Buffer.from(p, "base64"));
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(checkId, field));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const isCurrentFormat = (payload) => typeof payload === "string" && payload.startsWith(`${VERSION}.`);

module.exports = { encryptIdentity, decryptIdentity, isCurrentFormat, VERSION };
