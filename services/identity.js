// Vérification d'identité des prestataires : types de pièce, lecture des images, format des réponses.
const DOC_TYPES = {
  cni: "Carte nationale d'identité",
  passport: "Passeport",
  attestation: "Attestation d'identité",
  permis: "Permis de conduire",
};
const IMAGE_MAX_BYTES = 300 * 1024;
const IMAGE_MIN_BYTES = 1024; // en dessous, ce n'est pas une vraie photo
const MAX_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// Type réel d'après les octets magiques (jamais d'après le préfixe déclaré).
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

// Data URL base64 JPEG / PNG / WebP, 300 Ko max après décodage. Renvoie { value } ou { error }.
function readImage(v, label) {
  const m = typeof v === "string" && /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if (!m) return { error: `${label} : image JPEG, PNG ou WebP attendue` };
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > IMAGE_MAX_BYTES) return { error: `${label} trop lourde (300 Ko maximum)` };
  const type = sniff(buf);
  if (!type || buf.length < IMAGE_MIN_BYTES) return { error: `${label} : le fichier envoyé n'est pas une image valide` };
  return { value: `data:image/${type};base64,${m[2]}`, bytes: buf };
}

function validateSubmission(body) {
  const errors = {};
  // Chaîne exigée : un tableau ["cni"] passerait le test d'appartenance (clé convertie en texte).
  const raw = body?.docType;
  const docType = typeof raw === "string" && Object.prototype.hasOwnProperty.call(DOC_TYPES, raw) ? raw : null;
  if (!docType) errors.docType = "Choisissez le type de pièce d'identité";
  const document = readImage(body?.document, "La photo de la pièce");
  if (document.error) errors.document = document.error;
  const selfie = readImage(body?.selfie, "Le selfie");
  if (selfie.error) errors.selfie = selfie.error;
  if (!errors.document && !errors.selfie && document.bytes.equals(selfie.bytes)) {
    errors.selfie = "Le selfie doit être une autre photo que celle de la pièce";
  }
  return Object.keys(errors).length ? { errors } : { docType, document: document.value, selfie: selfie.value };
}

// Vue de l'utilisateur sur sa demande (jamais les images).
const serializeCheck = (c) => (c ? {
  status: c.status,
  docType: c.docType,
  docTypeLabel: DOC_TYPES[c.docType] || c.docType,
  submittedAt: c.submittedAt,
  decidedAt: c.decidedAt || null,
  rejectReason: c.status === "rejected" ? c.rejectReason || "" : null,
} : null);

// ---------- Rétention des images ----------
const RETENTION_DAYS = 30;
const EXPIRED_REASON = "Demande expirée sans examen : vous pouvez la renvoyer.";
const NAME_CHANGED_REASON = "Nom du profil modifié : refaites la vérification";
const LEGACY_REASON = "Demande à renvoyer : format de stockage des photos obsolète.";
const ORPHAN_REASON = "Compte supprimé";
const IMAGE_FIELDS = ["document", "selfie"];
const PURGE = { $unset: { document: 1, selfie: 1 } };
const hasImagesFilter = { $or: IMAGE_FIELDS.map((f) => ({ [f]: { $exists: true } })) };

// Rejet d'office d'une demande en attente (atomique : rien si l'équipe l'a décidée entre-temps).
function rejectPendingUpdate(reason, now = new Date()) {
  return { $set: { status: "rejected", rejectReason: reason, decidedAt: now, decidedBy: null, hasImages: false }, ...PURGE };
}

// Rejette les demandes en attente depuis plus de `days` jours (utilisateur prévenu),
// rejette celles dont les images ne sont pas au format chiffré actuel (anciennes clés),
// et supprime les images restantes des demandes décidées (ex. après restauration d'une sauvegarde)
// ou dont le compte n'existe plus. Renvoie le nombre de demandes touchées par catégorie.
async function expireStaleChecks(days = RETENTION_DAYS) {
  const IdentityCheck = require("../models/IdentityCheck");
  const User = require("../models/User");
  const Notification = require("../models/Notification");
  const { VERSION } = require("../utils/identityCrypto");
  const now = new Date();
  const result = { expired: 0, legacy: 0, purged: 0, orphans: 0 };

  const notify = (check, message) => Notification.create({
    userId: check.user, type: "system_alert", title: "Vérification d'identité refusée", message,
    metadata: { identity: "rejected", checkId: String(check._id) },
  }).catch((e) => console.error("notification identité", e.message));

  const rejectEach = async (filter, reason, message) => {
    const ids = await IdentityCheck.find(filter).select("_id").lean();
    let n = 0;
    for (const { _id } of ids) {
      const check = await IdentityCheck.findOneAndUpdate({ _id, status: "pending" }, rejectPendingUpdate(reason, now), { new: true }).lean();
      if (check) { n += 1; await notify(check, message); }
    }
    return n;
  };

  // 1. En attente depuis trop longtemps.
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  result.expired = await rejectEach({ status: "pending", submittedAt: { $lt: cutoff } }, EXPIRED_REASON,
    `${EXPIRED_REASON} Vos photos ont été supprimées.`);

  // 2. En attente mais chiffrées dans un ancien format (illisibles avec la clé actuelle).
  const prefix = new RegExp(`^${VERSION}\\.`);
  result.legacy = await rejectEach({ status: "pending", $or: IMAGE_FIELDS.map((f) => ({ [f]: { $exists: true, $not: prefix } })) },
    LEGACY_REASON, `${LEGACY_REASON} Vos photos ont été supprimées.`);

  // 3. Décidées mais images encore présentes.
  const purged = await IdentityCheck.updateMany({ status: { $ne: "pending" }, ...hasImagesFilter }, { $set: { hasImages: false }, ...PURGE });
  result.purged = purged.modifiedCount || 0;

  // 4. Compte disparu : images supprimées, demande en attente refusée.
  const owners = await IdentityCheck.distinct("user", hasImagesFilter);
  if (owners.length) {
    const alive = new Set((await User.find({ _id: { $in: owners } }).select("_id").lean()).map((u) => String(u._id)));
    const gone = owners.filter((id) => !alive.has(String(id)));
    if (gone.length) {
      const r = await IdentityCheck.updateMany({ user: { $in: gone }, status: "pending" }, rejectPendingUpdate(ORPHAN_REASON, now));
      const r2 = await IdentityCheck.updateMany({ user: { $in: gone }, ...hasImagesFilter }, { $set: { hasImages: false }, ...PURGE });
      result.orphans = (r.modifiedCount || 0) + (r2.modifiedCount || 0);
    }
  }
  return result;
}

// Lancement au démarrage du serveur puis toutes les 24 h (jamais pendant les tests).
function scheduleRetention({ intervalMs = DAY_MS } = {}) {
  if (process.env.NODE_ENV === "test") return null;
  const run = () => expireStaleChecks()
    .then((r) => { if (Object.values(r).some(Boolean)) console.log("🧹 Vérifications d'identité :", JSON.stringify(r)); })
    .catch((err) => console.error("Rétention identité :", err.message));
  run();
  return setInterval(run, intervalMs).unref();
}

module.exports = {
  DOC_TYPES, IMAGE_MAX_BYTES, MAX_PER_DAY, DAY_MS, RETENTION_DAYS, EXPIRED_REASON, NAME_CHANGED_REASON,
  sniff, readImage, validateSubmission, serializeCheck, rejectPendingUpdate, expireStaleChecks, scheduleRetention,
};
