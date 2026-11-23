// Chiffrement des messages bloqués (AES-256-GCM).
// Clé : CHAT_ENCRYPTION_KEY dans .env (64 caractères hexadécimaux = 32 octets).
// Sans clé valide, le contenu bloqué n'est pas conservé du tout (jamais en clair).
const crypto = require("crypto");

let warned = false;
function getKey() {
  const hex = process.env.CHAT_ENCRYPTION_KEY || "";
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  if (!warned) {
    console.warn("⚠️ CHAT_ENCRYPTION_KEY absente ou invalide : les messages bloqués ne seront pas conservés.");
    warned = true;
  }
  return null;
}

// Renvoie "iv.tag.données" en base64, ou null si aucune clé.
function encrypt(text) {
  const key = getKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

function decrypt(payload) {
  const key = getKey();
  if (!key || !payload) return null;
  const [iv, tag, data] = payload.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

module.exports = { encrypt, decrypt };
