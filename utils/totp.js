// Codes à usage unique (TOTP, RFC 6238) compatibles avec Google Authenticator, Microsoft
// Authenticator, Authy… : code de 6 chiffres renouvelé toutes les 30 secondes.
const crypto = require("crypto");

const STEP = 30;
const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0; const out = [];
  for (const c of clean) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("clé base32 invalide");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// Clé secrète de 160 bits, en base32 (format attendu par les applications d'authentification).
const generateSecret = () => base32Encode(crypto.randomBytes(20));

const stepAt = (time = Date.now()) => Math.floor(time / 1000 / STEP);

function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const n = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** DIGITS;
  return String(n).padStart(DIGITS, "0");
}

// Vérifie un code (±1 pas de 30 s pour l'horloge du téléphone). Renvoie le pas accepté, ou null.
// `afterStep` : dernier pas déjà utilisé → un code ne sert qu'une fois (pas de rejeu).
function verify(secret, code, { time = Date.now(), afterStep = -1 } = {}) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const now = stepAt(time);
  for (const s of [now - 1, now, now + 1]) {
    if (s <= afterStep) continue;
    const expected = codeAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return s;
  }
  return null;
}

// Adresse otpauth:// lue par les applications (QR code ou lien direct sur téléphone).
function otpauthUrl(secret, account, issuer = "ISD") {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

// Codes de secours : 10 codes « ABCD-EFGH » (sans 0/O ni 1/I), stockés hachés, utilisables une fois.
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const b = crypto.randomBytes(8);
    const s = [...b].map((x) => RECOVERY_ALPHABET[x % RECOVERY_ALPHABET.length]).join("");
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}
const normalizeRecovery = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const hashRecovery = (code) => crypto.createHash("sha256").update(normalizeRecovery(code)).digest("hex");

module.exports = { STEP, generateSecret, codeAt, stepAt, verify, otpauthUrl, generateRecoveryCodes, hashRecovery, normalizeRecovery, base32Encode, base32Decode };
