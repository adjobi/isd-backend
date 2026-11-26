process.env.CHAT_ENCRYPTION_KEY = process.env.CHAT_ENCRYPTION_KEY || "b".repeat(64);
process.env.IDENTITY_ENCRYPTION_KEY = "c".repeat(64);
const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const User = require("../models/User");
const IdentityCheck = require("../models/IdentityCheck");
const Notification = require("../models/Notification");
const AdminLog = require("../models/AdminLog");
const Offer = require("../models/Offer");
const Contract = require("../models/Contract");
const { ChatSession } = require("../models/Chat");
const { encrypt } = require("../utils/crypto");
const identityCrypto = require("../utils/identityCrypto");
const { encryptIdentity, decryptIdentity } = identityCrypto;
const { identityLimiter } = require("../routes/identityRoutes");
const identity = require("../services/identity");
const { tokenFor, buildApp } = require("./helpers");

const app = buildApp();
const NANNY_ID = "64b0000000000000000000c1";
const FAMILY_ID = "64b0000000000000000000a1";
const ADMIN_ID = "64b0000000000000000000e1";
const CHECK_ID = "64b0000000000000000000d1";
const NANNY = tokenFor(NANNY_ID, "nanny");
const FAMILY = tokenFor(FAMILY_ID, "family");
const ADMIN = tokenFor(ADMIN_ID, "family");
const HOUR = 3600 * 1000;

// Imite une requête Mongoose (select/sort/limit/populate/lean, ou await direct).
const q = (doc, calls = {}) => {
  const o = {};
  ["select", "sort", "limit", "populate"].forEach((m) => { o[m] = (arg) => { (calls[m] ||= []).push(arg); return o; }; });
  o.lean = async () => doc;
  o.then = (res, rej) => Promise.resolve(doc).then(res, rej);
  return o;
};

// Images réalistes : bons octets magiques, taille d'une vraie photo.
const img = (magic, size, fill = 1) => Buffer.concat([Buffer.from(magic), Buffer.alloc(size - magic.length, fill)]);
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP_MAGIC = [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")];
const dataUrl = (type, buf) => `data:image/${type};base64,${buf.toString("base64")}`;
const DOC = dataUrl("jpeg", img(JPEG_MAGIC, 4000));
const SELFIE = dataUrl("png", img(PNG_MAGIC, 3000));
const PROFILE = dataUrl("jpeg", img(JPEG_MAGIC, 2000, 7));
const body = (extra = {}) => ({ docType: "cni", document: DOC, selfie: SELFIE, ...extra });

const as = (method, url, token, data) => {
  const r = request(app)[method](url).set("Authorization", `Bearer ${token}`);
  return data ? r.send(data) : r;
};

// Comptes : l'admin (relu par middleware/admin.js), la nounou, la famille.
const users = (nanny = {}) => mock.method(User, "findById", (id) => {
  if (String(id) === ADMIN_ID) return q({ _id: ADMIN_ID, isAdmin: true, twoFactorEnabled: false });
  if (String(id) === FAMILY_ID) return q({ _id: FAMILY_ID, role: "family", isAdmin: false });
  return q({ _id: NANNY_ID, role: "nanny", firstName: "Awa", lastName: "Koné", isVerified: false, photo: PROFILE, createdAt: new Date(), ...nanny });
});

// Envoi d'une demande, base simulée : aucune demande en cours, rien envoyé dans les 24 h.
const submitMocks = ({ pending = false, count = 0, createErr = null } = {}) => {
  mock.method(IdentityCheck, "exists", async () => (pending ? { _id: CHECK_ID } : null));
  mock.method(IdentityCheck, "countDocuments", async () => count);
  return mock.method(IdentityCheck, "create", async (doc) => {
    if (createErr) throw createErr;
    return { _id: CHECK_ID, status: "pending", ...doc };
  });
};

describe("Vérification d'identité : envoi", () => {
  afterEach(() => { mock.restoreAll(); identityLimiter.reset(); });

  test("réservée aux nounous et répétiteurs (famille 403, sans connexion 401)", async () => {
    const create = submitMocks();
    assert.equal((await request(app).post("/api/identity").send(body())).status, 401);
    const res = await as("post", "/api/identity", FAMILY, body());
    assert.equal(res.status, 403);
    assert.equal(create.mock.callCount(), 0);
  });

  test("validation par champ : type de pièce, data URL, octets magiques, taille, selfie identique", async () => {
    const create = submitMocks();
    users();
    const send = (b) => as("post", "/api/identity", NANNY, b);

    let res = await send(body({ docType: "carte", document: "pas une image", selfie: "data:image/gif;base64,R0lGOD==" }));
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.docType && res.body.errors.document && res.body.errors.selfie);

    // Préfixe JPEG mais contenu qui n'est pas une image
    res = await send(body({ document: dataUrl("jpeg", Buffer.alloc(4000, 0x41)) }));
    assert.equal(res.status, 400);
    assert.match(res.body.errors.document, /pas une image valide/);

    // Plus de 300 Ko après décodage
    res = await send(body({ selfie: dataUrl("jpeg", img(JPEG_MAGIC, 300 * 1024 + 1)) }));
    assert.equal(res.status, 400);
    assert.match(res.body.errors.selfie, /300 Ko/);

    // Fichier minuscule : pas une vraie photo
    res = await send(body({ document: dataUrl("jpeg", Buffer.from(JPEG_MAGIC)) }));
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.document);

    res = await send(body({ selfie: DOC }));
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.selfie);
    assert.equal(create.mock.callCount(), 0);
  });

  test("201 : deux photos de 300 Ko passent la limite du corps, images chiffrées, type réel retenu (WebP)", async () => {
    const create = submitMocks();
    users();
    const big1 = dataUrl("jpeg", img(JPEG_MAGIC, 300 * 1024));
    const big2 = dataUrl("png", img(WEBP_MAGIC, 300 * 1024)); // préfixe PNG, contenu WebP
    const res = await as("post", "/api/identity", NANNY, body({ docType: "passport", document: big1, selfie: big2 }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body.check).sort(), ["docType", "docTypeLabel", "status", "submittedAt"]);
    assert.equal(res.body.check.status, "pending");
    assert.equal(res.body.check.docTypeLabel, "Passeport");
    const saved = create.mock.calls[0].arguments[0];
    assert.equal(String(saved.user), NANNY_ID);
    // Nom du profil figé à l'envoi
    assert.equal(saved.firstName, "Awa");
    assert.equal(saved.lastName, "Koné");
    // Chiffré avec la clé dédiée, préfixe de version, AAD = id de la demande (créé avant le chiffrement)
    assert.ok(saved._id, "identifiant généré avant le chiffrement");
    assert.ok(saved.document.startsWith("v1.") && saved.selfie.startsWith("v1."));
    assert.ok(!saved.document.includes("data:"), "jamais en clair");
    assert.equal(decryptIdentity(saved.document, saved._id, "document"), big1);
    assert.ok(decryptIdentity(saved.selfie, saved._id, "selfie").startsWith("data:image/webp;base64,"));
    assert.equal(decryptIdentity(saved.document, CHECK_ID, "document"), null, "lié à cette demande");
  });

  test("corps trop volumineux (> 900 Ko) : 413", async () => {
    users();
    const huge = "A".repeat(950 * 1024);
    const res = await as("post", "/api/identity", NANNY, { docType: "cni", document: huge, selfie: huge });
    assert.equal(res.status, 413);
  });

  test("409 si déjà vérifiée, 409 si une demande est en cours (y compris envois simultanés)", async () => {
    users({ isVerified: true });
    submitMocks();
    let res = await as("post", "/api/identity", NANNY, body());
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "Votre identité est déjà vérifiée.");

    mock.restoreAll();
    users();
    submitMocks({ pending: true });
    res = await as("post", "/api/identity", NANNY, body());
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "Une vérification est déjà en cours.");

    mock.restoreAll();
    users();
    submitMocks({ createErr: Object.assign(new Error("E11000"), { code: 11000 }) });
    res = await as("post", "/api/identity", NANNY, body());
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "Une vérification est déjà en cours.");
  });

  test("429 au-delà de 3 envois en 24 h", async () => {
    users();
    const create = submitMocks({ count: 3 });
    const res = await as("post", "/api/identity", NANNY, body());
    assert.equal(res.status, 429);
    assert.equal(create.mock.callCount(), 0);
  });

  test("sans clé dédiée valide (absente, ou identique à celle du chat) : rien n'est enregistré (503)", async () => {
    const prev = process.env.IDENTITY_ENCRYPTION_KEY;
    mock.method(console, "warn", () => {});
    try {
      for (const key of ["", "abc", process.env.CHAT_ENCRYPTION_KEY]) {
        process.env.IDENTITY_ENCRYPTION_KEY = key;
        mock.restoreAll();
        mock.method(console, "warn", () => {});
        users();
        const create = submitMocks();
        const res = await as("post", "/api/identity", NANNY, body());
        assert.equal(res.status, 503, `clé ${key.length} caractères`);
        assert.equal(create.mock.callCount(), 0);
      }
    } finally {
      process.env.IDENTITY_ENCRYPTION_KEY = prev;
    }
  });

  test("champs qui ne sont pas des chaînes (docType tableau, objet…) : 400, jamais 500", async () => {
    users();
    const create = submitMocks();
    for (const extra of [{ docType: ["cni"] }, { docType: { cni: 1 } }, { docType: 1 }, { document: [DOC] }, { selfie: { a: SELFIE } }]) {
      const res = await as("post", "/api/identity", NANNY, body(extra));
      assert.equal(res.status, 400, JSON.stringify(extra).slice(0, 40));
      assert.ok(Object.keys(res.body.errors).length >= 1);
    }
    const res = await as("post", "/api/identity", NANNY, body({ docType: ["cni"] }));
    assert.ok(res.body.errors.docType);
    assert.equal(create.mock.callCount(), 0);
  });

  test("anonyme ou mauvais rôle : le corps n'est jamais lu (pas de 413 ni de 400 de lecture)", async () => {
    const huge = { docType: "cni", document: "A".repeat(950 * 1024) };
    let res = await request(app).post("/api/identity").send(huge);
    assert.equal(res.status, 401);
    res = await request(app).post("/API/Identity/").send(huge);
    assert.equal(res.status, 401);
    res = await request(app).post("/api/identity").set("Content-Type", "application/json").send("{pas du json");
    assert.equal(res.status, 401);
    res = await as("post", "/api/identity", FAMILY, huge);
    assert.equal(res.status, 403);
    // Une fois connecté avec le bon rôle, le corps est lu (limite 900 Ko) : JSON invalide → 400
    users();
    res = await request(app).post("/api/identity").set("Authorization", `Bearer ${NANNY}`).set("Content-Type", "application/json").send("{pas du json");
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "Requête mal formée");
  });

  test("parseur global : /api/identity exclu, autres routes inchangées", () => {
    const { isIdentityPath } = require("../middleware/bodyParsing");
    assert.ok(isIdentityPath("/api/identity"));
    assert.ok(isIdentityPath("/api/identity/"));
    assert.ok(isIdentityPath("/API/IDENTITY"));
    assert.ok(!isIdentityPath("/api/identityx"));
    assert.ok(!isIdentityPath("/api/auth/profile"));
    assert.ok(!isIdentityPath("/api/admin/identity"));
  });

  test("limiteur : 10 tentatives par heure et par compte, invalides comprises, puis 429", async () => {
    users();
    const create = submitMocks();
    for (let i = 0; i < 10; i += 1) {
      const res = await as("post", "/api/identity", NANNY, { docType: "carte" });
      assert.equal(res.status, 400);
    }
    let res = await as("post", "/api/identity", NANNY, body());
    assert.equal(res.status, 429);
    assert.equal(res.body.message, "Trop de tentatives d'envoi. Réessayez dans une heure.");
    assert.ok(Number(res.headers["retry-after"]) > 0);
    // Corps trop lourd : compte aussi, et toujours 429 avant toute lecture
    res = await as("post", "/api/identity", NANNY, { document: "A".repeat(950 * 1024) });
    assert.equal(res.status, 429);
    assert.equal(create.mock.callCount(), 0);
    // Un autre compte n'est pas bloqué
    const other = tokenFor("64b0000000000000000000c2", "tutor");
    res = await as("post", "/api/identity", other, { docType: "carte" });
    assert.equal(res.status, 400);
  });
});

describe("Vérification d'identité : statut", () => {
  afterEach(() => mock.restoreAll());

  test("GET : statut et dernière demande, jamais les images", async () => {
    const verifiedAt = new Date();
    users({ isVerified: true, verifiedAt });
    const calls = {};
    mock.method(IdentityCheck, "findOne", () => q({ status: "approved", docType: "permis", submittedAt: new Date(), decidedAt: new Date() }, calls));
    const res = await as("get", "/api/identity", NANNY);
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.verifiedAt, verifiedAt.toISOString());
    assert.equal(res.body.check.status, "approved");
    assert.equal(res.body.check.docTypeLabel, "Permis de conduire");
    assert.equal(res.body.check.rejectReason, null);
    assert.ok(!/document|selfie/.test(calls.select.join(" ")));
  });

  test("GET : aucune demande → check null ; refus → motif", async () => {
    users();
    mock.method(IdentityCheck, "findOne", () => q(null));
    let res = await as("get", "/api/identity", NANNY);
    assert.deepEqual(res.body, { verified: false, verifiedAt: null, check: null });
    mock.restoreAll();
    users();
    mock.method(IdentityCheck, "findOne", () => q({ status: "rejected", docType: "cni", submittedAt: new Date(), decidedAt: new Date(), rejectReason: "Photo floue" }));
    res = await as("get", "/api/identity", NANNY);
    assert.equal(res.body.check.rejectReason, "Photo floue");
  });
});

describe("Vérification d'identité : Espace ISD", () => {
  afterEach(() => mock.restoreAll());
  const logs = () => mock.method(AdminLog, "create", async () => ({}));
  const stored = (extra = {}) => ({
    _id: CHECK_ID, user: NANNY_ID, docType: "cni", status: "pending",
    document: encryptIdentity(DOC, CHECK_ID, "document"), selfie: encryptIdentity(SELFIE, CHECK_ID, "selfie"), ...extra,
  });

  test("réservé à l'équipe ISD (non-admin 403)", async () => {
    users();
    for (const [m, url] of [["get", "/api/admin/identity"], ["get", `/api/admin/identity/${CHECK_ID}/images`], ["post", `/api/admin/identity/${CHECK_ID}/approve`]]) {
      assert.equal((await as(m, url, NANNY)).status, 403, url);
    }
    assert.equal((await as("get", "/api/admin/identity/xyz/images", ADMIN)).status, 400);
  });

  test("liste : en attente du plus ancien, compteur, photo de profil signalée, jamais les images", async () => {
    users();
    const calls = {};
    const find = mock.method(IdentityCheck, "find", () => q([{
      _id: CHECK_ID, user: { _id: NANNY_ID, firstName: "Awa", lastName: "Koné", role: "nanny", commune: "Cocody", city: "Abidjan" },
      docType: "attestation", status: "pending", submittedAt: new Date(), hasImages: true, decidedBy: null,
    }], calls));
    mock.method(User, "find", () => q([{ _id: NANNY_ID }]));
    mock.method(IdentityCheck, "countDocuments", async (f) => (f.status === "pending" ? 4 : 99));
    const res = await as("get", "/api/admin/identity?status=nimporte", ADMIN);
    assert.equal(res.status, 200);
    assert.deepEqual(find.mock.calls[0].arguments[0], { status: "pending" });
    assert.deepEqual(calls.sort[0], { submittedAt: 1 });
    assert.equal(res.body.pending, 4);
    const [c] = res.body.checks;
    assert.equal(c.docTypeLabel, "Attestation d'identité");
    assert.equal(c.user.hasPhoto, true);
    assert.equal(c.hasImages, true);
    assert.equal(c.decidedBy, null);
    assert.ok(!/document|selfie|photo"/.test(calls.select.join(" ") + JSON.stringify(res.body)));
    assert.ok(!calls.populate.some((p) => /photo|phone|email/.test(p)));

    await as("get", "/api/admin/identity?status=rejected", ADMIN);
    assert.deepEqual(find.mock.calls[1].arguments[0], { status: "rejected" });
    assert.deepEqual(calls.sort[1], { submittedAt: -1 });
  });

  test("images : déchiffrées, photo de profil, no-store, consultation journalisée sans contenu", async () => {
    users();
    const log = logs();
    mock.method(IdentityCheck, "findById", () => q(stored()));
    const res = await as("get", `/api/admin/identity/${CHECK_ID}/images`, ADMIN);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { document: DOC, selfie: SELFIE, profilePhoto: PROFILE });
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers.pragma, "no-cache");
    const entry = log.mock.calls[0].arguments[0];
    assert.equal(entry.action, "identity_viewed");
    assert.ok(!JSON.stringify(entry).includes("base64"));
  });

  test("images : 410 après décision, 403 sur sa propre demande, 404", async () => {
    users();
    logs();
    mock.method(IdentityCheck, "findById", (id) => {
      if (String(id) === CHECK_ID) return q({ _id: CHECK_ID, user: NANNY_ID, status: "approved" });
      if (String(id) === "64b0000000000000000000d2") return q(stored({ user: ADMIN_ID }));
      return q(null);
    });
    let res = await as("get", `/api/admin/identity/${CHECK_ID}/images`, ADMIN);
    assert.equal(res.status, 410);
    assert.equal(res.body.message, "Images supprimées après décision.");
    assert.equal(res.headers["cache-control"], "no-store");
    res = await as("get", "/api/admin/identity/64b0000000000000000000d2/images", ADMIN);
    assert.equal(res.status, 403);
    res = await as("get", "/api/admin/identity/64b0000000000000000000d3/images", ADMIN);
    assert.equal(res.status, 404);
  });

  test("validation atomique : images supprimées ($unset), profil vérifié, notification, journal", async () => {
    users();
    const log = logs();
    const decided = { _id: CHECK_ID, user: NANNY_ID, firstName: "Awa", lastName: "Koné", docType: "cni", status: "approved", decidedAt: new Date() };
    const fou = mock.method(IdentityCheck, "findOneAndUpdate", () => q(decided));
    const upd = mock.method(User, "updateOne", async () => ({ matchedCount: 1, modifiedCount: 1 }));
    const note = mock.method(Notification, "create", async (n) => n);
    const res = await as("post", `/api/admin/identity/${CHECK_ID}/approve`, ADMIN);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [filter, update] = fou.mock.calls[0].arguments;
    assert.equal(filter.status, "pending");
    assert.deepEqual(filter.user, { $ne: ADMIN_ID });
    assert.equal(update.$set.status, "approved");
    assert.equal(update.$set.decidedBy, ADMIN_ID);
    assert.equal(update.$set.hasImages, false);
    assert.deepEqual(update.$unset, { document: 1, selfie: 1 });
    const [uFilter, uUpdate] = upd.mock.calls[0].arguments;
    // Badge appliqué seulement si le nom est encore celui de l'envoi
    assert.deepEqual(uFilter, { _id: NANNY_ID, firstName: "Awa", lastName: "Koné" });
    assert.equal(uUpdate.$set.isVerified, true);
    assert.ok(uUpdate.$set.verifiedAt instanceof Date);
    assert.equal(note.mock.calls[0].arguments[0].title, "Identité vérifiée");
    assert.equal(String(note.mock.calls[0].arguments[0].userId), NANNY_ID);
    assert.equal(log.mock.calls[0].arguments[0].action, "identity_approved");
  });

  test("décision : 409 si déjà décidée, 403 sur sa propre demande, 404", async () => {
    users();
    logs();
    mock.method(IdentityCheck, "findOneAndUpdate", () => q(null));
    const upd = mock.method(User, "updateOne", async () => ({}));
    mock.method(IdentityCheck, "findById", (id) => {
      if (String(id) === CHECK_ID) return q({ _id: CHECK_ID, user: NANNY_ID, status: "approved" });
      if (String(id) === "64b0000000000000000000d2") return q({ user: ADMIN_ID, status: "pending" });
      return q(null);
    });
    let res = await as("post", `/api/admin/identity/${CHECK_ID}/approve`, ADMIN);
    assert.equal(res.status, 409);
    res = await as("post", `/api/admin/identity/${CHECK_ID}/reject`, ADMIN, { reason: "Photo illisible" });
    assert.equal(res.status, 409);
    res = await as("post", "/api/admin/identity/64b0000000000000000000d2/approve", ADMIN);
    assert.equal(res.status, 403);
    res = await as("post", "/api/admin/identity/64b0000000000000000000d3/approve", ADMIN);
    assert.equal(res.status, 404);
    assert.equal(upd.mock.callCount(), 0);
  });

  test("refus : motif obligatoire, sans coordonnées, notifié, images supprimées, profil inchangé", async () => {
    users();
    const log = logs();
    const fou = mock.method(IdentityCheck, "findOneAndUpdate", (f, u) => q({ _id: CHECK_ID, user: NANNY_ID, docType: "cni", ...u.$set }));
    const upd = mock.method(User, "updateOne", async () => ({}));
    const note = mock.method(Notification, "create", async (n) => n);
    const url = `/api/admin/identity/${CHECK_ID}/reject`;
    assert.equal((await as("post", url, ADMIN, { reason: "non" })).status, 400);
    const contact = await as("post", url, ADMIN, { reason: "Appelez-moi au 07 12 34 56 78" });
    assert.equal(contact.status, 400);
    assert.ok(contact.body.errors.reason);
    assert.equal(fou.mock.callCount(), 0);

    const res = await as("post", url, ADMIN, { reason: "  Photo de la pièce   floue " });
    assert.equal(res.status, 200);
    const update = fou.mock.calls[0].arguments[1];
    assert.equal(update.$set.status, "rejected");
    assert.equal(update.$set.rejectReason, "Photo de la pièce floue");
    assert.deepEqual(update.$unset, { document: 1, selfie: 1 });
    assert.equal(upd.mock.callCount(), 0);
    assert.match(note.mock.calls[0].arguments[0].message, /Photo de la pièce floue/);
    assert.equal(log.mock.calls[0].arguments[0].action, "identity_rejected");
    assert.equal(res.body.check.rejectReason, "Photo de la pièce floue");
  });
});

describe("Vérification d'identité : profil et actions", () => {
  afterEach(() => mock.restoreAll());

  // Profil actuel (vérifié) relu avant l'écriture ; l'écriture renvoie le profil mis à jour.
  const VERIFIED = { _id: NANNY_ID, role: "nanny", firstName: "Awa", lastName: "Koné", photo: PROFILE, photoUpdatedAt: new Date(), isVerified: true, verifiedAt: new Date() };
  const profileMocks = ({ current = VERIFIED, cancelled = 0, delayMs = 0 } = {}) => {
    const state = { written: false };
    mock.method(User, "findById", () => q(current));
    const upd = mock.method(User, "updateOne", async () => ({ modifiedCount: 1 }));
    const write = mock.method(User, "findByIdAndUpdate", (id, u) => {
      const o = { select: () => o };
      o.lean = () => new Promise((resolve) => setTimeout(() => {
        const doc = { ...current, ...u.$set };
        Object.keys(u.$unset || {}).forEach((k) => delete doc[k]);
        state.written = true;
        resolve(doc);
      }, delayMs));
      return o;
    });
    const many = mock.method(IdentityCheck, "updateMany", async () => ({ modifiedCount: cancelled }));
    return { upd, write, many, state };
  };

  test("changement de nom : badge retiré dans la même écriture que le profil, demande en attente annulée", async () => {
    const { upd, write, many } = profileMocks({ cancelled: 1 });
    const res = await as("put", "/api/auth/profile", NANNY, { firstName: "Aya", lastName: "Koné" });
    assert.equal(res.status, 200);
    assert.equal(write.mock.callCount(), 1);
    const update = write.mock.calls[0].arguments[1];
    assert.equal(update.$set.firstName, "Aya");
    assert.equal(update.$set.isVerified, false);
    assert.deepEqual(update.$unset, { verifiedAt: 1 });
    assert.equal(upd.mock.callCount(), 0, "plus d'écriture séparée avant le profil");
    // Demande en attente rejetée d'office, images supprimées
    const [filter, reject] = many.mock.calls[0].arguments;
    assert.deepEqual(filter, { user: NANNY_ID, status: "pending" });
    assert.equal(reject.$set.status, "rejected");
    assert.equal(reject.$set.rejectReason, "Nom du profil modifié : refaites la vérification");
    assert.equal(reject.$set.hasImages, false);
    assert.deepEqual(reject.$unset, { document: 1, selfie: 1 });
    assert.equal(res.body.user.isVerified, false);
    assert.equal(res.body.user.verifiedAt, undefined);
    assert.equal(res.body.notice, "Nom du profil modifié : refaites la vérification.");
  });

  test("l'écriture du profil (avec le retrait du badge) est attendue avant la réponse", async () => {
    const { state } = profileMocks({ delayMs: 30 });
    const res = await as("put", "/api/auth/profile", NANNY, { lastName: "Kouassi" });
    assert.equal(res.status, 200);
    assert.ok(state.written, "réponse envoyée avant la fin de l'écriture");
    // Le profil renvoyé est celui écrit (badge retiré), pas une copie locale
    assert.equal(res.body.user.isVerified, false);
    assert.equal(res.body.user.lastName, "Kouassi");
    assert.match(res.body.notice, /refaites la vérification d'identité/);
  });

  test("photo de profil changée après validation : badge retiré ; même photo : badge conservé", async () => {
    const NEW_PHOTO = dataUrl("jpeg", img(JPEG_MAGIC, 2000, 9));
    let { write, many } = profileMocks();
    let res = await as("put", "/api/auth/profile", NANNY, { photo: NEW_PHOTO });
    assert.equal(res.status, 200);
    let update = write.mock.calls[0].arguments[1];
    assert.equal(update.$set.isVerified, false);
    assert.deepEqual(update.$unset, { verifiedAt: 1 });
    assert.equal(many.mock.callCount(), 0, "la photo n'annule pas une demande en attente");
    assert.equal(res.body.user.isVerified, false);

    mock.restoreAll();
    ({ write } = profileMocks());
    res = await as("put", "/api/auth/profile", NANNY, { photo: "" });
    assert.equal(write.mock.calls[0].arguments[1].$set.isVerified, false, "suppression de la photo");

    mock.restoreAll();
    ({ write } = profileMocks());
    res = await as("put", "/api/auth/profile", NANNY, { photo: PROFILE, firstName: "Awa" });
    update = write.mock.calls[0].arguments[1];
    assert.equal(update.$set.isVerified, undefined);
    assert.equal(update.$unset, undefined);
    assert.equal(res.body.user.isVerified, true);
    assert.equal(res.body.notice, undefined);
  });

  test("autre modification du profil : vérification conservée, profil non relu", async () => {
    const { upd, write, many } = profileMocks();
    const look = User.findById;
    const res = await as("put", "/api/auth/profile", NANNY, { bio: "Nounou depuis 5 ans" });
    assert.equal(res.status, 200);
    assert.equal(look.mock.callCount(), 0);
    assert.equal(upd.mock.callCount(), 0);
    assert.equal(many.mock.callCount(), 0);
    assert.equal(write.mock.calls[0].arguments[1].$unset, undefined);
  });

  const actionMocks = (user, check) => {
    mock.method(Offer, "find", () => q([]));
    mock.method(ChatSession, "find", () => q([]));
    mock.method(Contract, "find", () => q([]));
    mock.method(User, "findById", () => q(user));
    mock.method(IdentityCheck, "findOne", () => q(check));
  };
  const kinds = async (token = NANNY) => (await as("get", "/api/actions", token)).body.actions;

  test("action « identity » pour un prestataire non vérifié sans demande", async () => {
    actionMocks({ _id: NANNY_ID, role: "nanny", isVerified: false, createdAt: new Date() }, null);
    const [a] = await kinds();
    assert.equal(a.kind, "identity");
    assert.equal(a.id, "identity");
    assert.equal(a.route, "IdentityVerification");
    assert.equal(a.title, "Faites vérifier votre identité");
    assert.deepEqual(a.params, {});
  });

  test("action « identity » absente : vérifié, demande en cours, refus de moins de 24 h ; présente après 24 h", async () => {
    const base = { _id: NANNY_ID, role: "tutor", isVerified: false, createdAt: new Date() };
    const cases = [
      [{ ...base, isVerified: true }, null, 0],
      [base, { status: "pending", submittedAt: new Date() }, 0],
      [base, { status: "rejected", decidedAt: new Date(Date.now() - 2 * HOUR) }, 0],
      [base, { status: "rejected", decidedAt: new Date(Date.now() - 25 * HOUR) }, 1],
    ];
    for (const [user, check, expected] of cases) {
      mock.restoreAll();
      actionMocks(user, check);
      assert.equal((await kinds()).filter((a) => a.kind === "identity").length, expected, JSON.stringify(check));
    }
  });

  test("famille : jamais d'action « identity »", async () => {
    mock.method(Offer, "find", () => q([]));
    mock.method(ChatSession, "find", () => q([]));
    mock.method(Contract, "find", () => q([]));
    mock.method(require("../models/Invoice"), "find", () => q([]));
    const look = mock.method(IdentityCheck, "findOne", () => q(null));
    assert.deepEqual(await kinds(FAMILY), []);
    assert.equal(look.mock.callCount(), 0);
  });
});

describe("Vérification d'identité : site public", () => {
  afterEach(() => mock.restoreAll());

  test("profils publics : seulement « verified », jamais le type de pièce ni la date", async () => {
    mock.method(User, "find", () => q([{
      _id: NANNY_ID, firstName: "Awa", lastName: "Koné", role: "nanny", city: "Abidjan", commune: "Yopougon",
      isVerified: true, verifiedAt: new Date(), docType: "cni", createdAt: new Date(),
    }]));
    mock.method(User, "countDocuments", async () => 1);
    const res = await request(app).get("/api/public/providers?commune=Yopougon");
    assert.equal(res.status, 200);
    const [p] = res.body.providers;
    assert.equal(p.verified, true);
    assert.ok(!/docType|verifiedAt|document|selfie/.test(JSON.stringify(res.body)));
  });
});

describe("Vérification d'identité : Espace ISD, nom et journal", () => {
  afterEach(() => mock.restoreAll());
  const stored = (extra = {}) => ({
    _id: CHECK_ID, user: NANNY_ID, docType: "cni", status: "pending",
    document: encryptIdentity(DOC, CHECK_ID, "document"), selfie: encryptIdentity(SELFIE, CHECK_ID, "selfie"), ...extra,
  });

  test("validation : nom modifié depuis l'envoi → 409, demande rejetée et purgée, utilisateur prévenu", async () => {
    users();
    const log = mock.method(AdminLog, "create", async () => ({}));
    mock.method(IdentityCheck, "findOneAndUpdate", () => q({ _id: CHECK_ID, user: NANNY_ID, firstName: "Awa", lastName: "Koné", docType: "cni", status: "approved" }));
    const upd = mock.method(User, "updateOne", async () => ({ matchedCount: 0, modifiedCount: 0 }));
    const checkUpd = mock.method(IdentityCheck, "updateOne", async () => ({ modifiedCount: 1 }));
    const note = mock.method(Notification, "create", async (n) => n);
    const res = await as("post", `/api/admin/identity/${CHECK_ID}/approve`, ADMIN);
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "Le nom du profil a changé depuis l'envoi : demande annulée.");
    assert.deepEqual(upd.mock.calls[0].arguments[0], { _id: NANNY_ID, firstName: "Awa", lastName: "Koné" });
    const [cFilter, cUpdate] = checkUpd.mock.calls[0].arguments;
    assert.equal(cFilter._id, CHECK_ID);
    assert.equal(cUpdate.$set.status, "rejected");
    assert.equal(cUpdate.$set.rejectReason, "Nom du profil modifié : refaites la vérification");
    assert.equal(cUpdate.$set.hasImages, false);
    assert.deepEqual(cUpdate.$unset, { document: 1, selfie: 1 });
    assert.match(note.mock.calls[0].arguments[0].message, /Nom du profil modifié/);
    assert.equal(log.mock.calls[0].arguments[0].action, "identity_rejected");
  });

  test("images : journal écrit et attendu AVANT le déchiffrement", async () => {
    users();
    const events = [];
    mock.method(IdentityCheck, "findById", () => q(stored()));
    mock.method(AdminLog, "create", (entry) => new Promise((resolve) => setTimeout(() => { events.push(`log:${entry.action}`); resolve(entry); }, 20)));
    const real = identityCrypto.decryptIdentity;
    mock.method(identityCrypto, "decryptIdentity", (...args) => { events.push(`decrypt:${args[2]}`); return real(...args); });
    const res = await as("get", `/api/admin/identity/${CHECK_ID}/images`, ADMIN);
    assert.equal(res.status, 200);
    assert.deepEqual(events, ["log:identity_viewed", "decrypt:document", "decrypt:selfie"]);
  });

  test("images : journal indisponible → 503, rien déchiffré ni renvoyé", async () => {
    users();
    mock.method(console, "error", () => {});
    mock.method(IdentityCheck, "findById", () => q(stored()));
    mock.method(AdminLog, "create", async () => { throw new Error("base en lecture seule"); });
    const dec = mock.method(identityCrypto, "decryptIdentity");
    const res = await as("get", `/api/admin/identity/${CHECK_ID}/images`, ADMIN);
    assert.equal(res.status, 503);
    assert.equal(res.body.message, "Journal indisponible : images non affichées. Réessayez dans un instant.");
    assert.equal(dec.mock.callCount(), 0);
    assert.ok(!/document|selfie|base64/.test(JSON.stringify(res.body)));
    assert.equal(res.headers["cache-control"], "no-store");
  });

  test("images : chiffrés intervertis (selfie ↔ pièce) ou d'une autre demande → 503", async () => {
    users();
    mock.method(AdminLog, "create", async () => ({}));
    const good = stored();
    const other = "64b0000000000000000000d9";
    mock.method(IdentityCheck, "findById", (id) => q(String(id) === CHECK_ID
      ? { ...good, document: good.selfie, selfie: good.document }
      : { ...good, _id: other }));
    let res = await as("get", `/api/admin/identity/${CHECK_ID}/images`, ADMIN);
    assert.equal(res.status, 503);
    res = await as("get", `/api/admin/identity/${other}/images`, ADMIN);
    assert.equal(res.status, 503);
  });
});

describe("Vérification d'identité : chiffrement dédié", () => {
  test("format v1, AAD liée à la demande et au champ, altération refusée", () => {
    const c = encryptIdentity("secret", CHECK_ID, "document");
    const parts = c.split(".");
    assert.equal(parts.length, 4);
    assert.equal(parts[0], "v1");
    assert.equal(Buffer.from(parts[1], "base64").length, 12);
    assert.equal(Buffer.from(parts[2], "base64").length, 16);
    assert.equal(decryptIdentity(c, CHECK_ID, "document"), "secret");
    assert.equal(decryptIdentity(c, CHECK_ID, "selfie"), null, "déplacé dans un autre champ");
    assert.equal(decryptIdentity(c, "64b0000000000000000000d9", "document"), null, "déplacé dans une autre demande");
    const data = Buffer.from(parts[3], "base64"); data[0] ^= 1;
    assert.equal(decryptIdentity([...parts.slice(0, 3), data.toString("base64")].join("."), CHECK_ID, "document"), null);
    assert.equal(decryptIdentity(`v2.${parts.slice(1).join(".")}`, CHECK_ID, "document"), null, "version inconnue");
    assert.equal(decryptIdentity([parts[0], parts[1], parts[2].slice(0, 8), parts[3]].join("."), CHECK_ID, "document"), null, "étiquette tronquée");
    assert.equal(decryptIdentity(encrypt("secret"), CHECK_ID, "document"), null, "ancien format / clé du chat");
  });

  test("config/env : IDENTITY_ENCRYPTION_KEY exigée, distincte de la clé du chat", () => {
    const { checkEnv } = require("../config/env");
    const prev = { ...process.env };
    try {
      Object.assign(process.env, { MONGO_URI: "mongodb://localhost/isd", JWT_SECRET: "x" });
      process.env.IDENTITY_ENCRYPTION_KEY = "";
      assert.ok(checkEnv().some((p) => /IDENTITY_ENCRYPTION_KEY doit faire 64/.test(p)));
      process.env.IDENTITY_ENCRYPTION_KEY = process.env.CHAT_ENCRYPTION_KEY;
      assert.ok(checkEnv().some((p) => /différente de CHAT_ENCRYPTION_KEY/.test(p)));
      process.env.IDENTITY_ENCRYPTION_KEY = "d".repeat(64);
      assert.ok(!checkEnv().some((p) => /IDENTITY/.test(p)));
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
      Object.assign(process.env, prev);
    }
  });
});

describe("Vérification d'identité : rétention (expireStaleChecks)", () => {
  afterEach(() => mock.restoreAll());

  const retentionMocks = ({ stale = [], legacy = [], decidedMeanwhile = [], owners = [], alive = [] } = {}) => {
    const finds = [];
    mock.method(IdentityCheck, "find", (filter) => {
      finds.push(filter);
      return q((filter.submittedAt ? stale : legacy).map((_id) => ({ _id })));
    });
    const fou = mock.method(IdentityCheck, "findOneAndUpdate", (f) => q(decidedMeanwhile.includes(f._id) ? null : { _id: f._id, user: NANNY_ID, status: "rejected" }));
    const many = mock.method(IdentityCheck, "updateMany", async () => ({ modifiedCount: 2 }));
    mock.method(IdentityCheck, "distinct", async () => owners);
    mock.method(User, "find", () => q(alive.map((_id) => ({ _id }))));
    const note = mock.method(Notification, "create", async (n) => n);
    return { finds, fou, many, note };
  };

  test("demandes en attente depuis plus de 30 jours rejetées, photos supprimées, utilisateur prévenu", async () => {
    const { finds, fou, many, note } = retentionMocks({ stale: ["a1", "a2"], decidedMeanwhile: ["a2"] });
    const before = Date.now();
    const r = await identity.expireStaleChecks();
    assert.equal(r.expired, 1, "a2 décidée entre-temps : ignorée");
    const cutoff = finds[0].submittedAt.$lt.getTime();
    assert.ok(Math.abs(before - 30 * 24 * 3600 * 1000 - cutoff) < 5000);
    assert.equal(finds[0].status, "pending");
    const [f, u] = fou.mock.calls[0].arguments;
    assert.deepEqual(f, { _id: "a1", status: "pending" });
    assert.equal(u.$set.status, "rejected");
    assert.equal(u.$set.rejectReason, "Demande expirée sans examen : vous pouvez la renvoyer.");
    assert.equal(u.$set.hasImages, false);
    assert.deepEqual(u.$unset, { document: 1, selfie: 1 });
    assert.equal(note.mock.callCount(), 1);
    assert.equal(String(note.mock.calls[0].arguments[0].userId), NANNY_ID);
    assert.match(note.mock.calls[0].arguments[0].message, /expirée/);
    // Photos restantes de demandes décidées : supprimées
    const [pf, pu] = many.mock.calls[0].arguments;
    assert.deepEqual(pf.status, { $ne: "pending" });
    assert.deepEqual(pu.$unset, { document: 1, selfie: 1 });
    assert.equal(r.purged, 2);
  });

  test("délai paramétrable ; demandes à l'ancien format rejetées ; comptes supprimés purgés", async () => {
    const GONE = "64b0000000000000000000f1";
    const { finds, many } = retentionMocks({ legacy: ["b1"], owners: [NANNY_ID, GONE], alive: [NANNY_ID] });
    const r = await identity.expireStaleChecks(7);
    assert.ok(Date.now() - finds[0].submittedAt.$lt.getTime() >= 7 * 24 * 3600 * 1000 - 5000);
    assert.ok(Date.now() - finds[0].submittedAt.$lt.getTime() < 8 * 24 * 3600 * 1000);
    assert.ok(/\^v1\\\./.test(String(finds[1].$or[0].document.$not)), "préfixe v1 exigé");
    assert.equal(r.legacy, 1);
    const orphanCalls = many.mock.calls.slice(1).map((c) => c.arguments);
    assert.equal(orphanCalls.length, 2);
    for (const [filter, update] of orphanCalls) {
      assert.deepEqual(filter.user.$in.map(String), [GONE]);
      assert.deepEqual(update.$unset, { document: 1, selfie: 1 });
    }
    assert.equal(orphanCalls[0][1].$set.status, "rejected");
    assert.equal(r.orphans, 4);
  });

  test("planification : rien en mode test", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      assert.equal(identity.scheduleRetention(), null);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev;
    }
  });
});
