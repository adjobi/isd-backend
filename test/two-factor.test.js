const { test, describe, afterEach, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

process.env.CHAT_ENCRYPTION_KEY = process.env.CHAT_ENCRYPTION_KEY || "a".repeat(64);
const User = require("../models/User");
const AdminLog = require("../models/AdminLog");
const { buildApp, tokenFor } = require("./helpers");
const throttle = require("../services/loginThrottle");
const totp = require("../utils/totp");
const twoFactor = require("../services/twoFactor");
const { encrypt } = require("../utils/crypto");

const app = buildApp();
const HASH = bcrypt.hashSync("Demo1234", 4);
const ID = "64b0000000000000000000a1";
const SECRET = totp.generateSecret();
const RECOVERY = "ABCD-EFGH";

const admin = (extra = {}) => ({
  _id: ID, email: "equipe@isd.ci", role: "family", password: HASH, firstName: "Awa", lastName: "K",
  isAdmin: true, twoFactorEnabled: true,
  twoFactor: { secret: encrypt(SECRET), lastStep: -1, recoveryCodes: [totp.hashRecovery(RECOVERY)] },
  ...extra,
});
// Imite une requête Mongoose : .select() chaînable, .lean(), et « await » direct.
const query = (doc) => { const q = { select: () => q, lean: async () => doc, then: (ok, ko) => Promise.resolve(doc).then(ok, ko) }; return q; };
const now = () => totp.codeAt(SECRET, totp.stepAt());

describe("Double authentification : codes TOTP", () => {
  test("vecteur de référence RFC 6238 (SHA-1, t = 59 s)", () => {
    const secret = totp.base32Encode(Buffer.from("12345678901234567890"));
    assert.equal(totp.codeAt(secret, Math.floor(59 / 30)), "287082");
    assert.equal(totp.verify(secret, "287082", { time: 59 * 1000 }), 1);
  });
  test("code d'un autre pas ou déjà utilisé : refusé", () => {
    const step = totp.stepAt();
    assert.equal(totp.verify(SECRET, totp.codeAt(SECRET, step - 3)), null);
    assert.equal(totp.verify(SECRET, totp.codeAt(SECRET, step), { afterStep: step }), null);
    assert.equal(totp.verify(SECRET, "12345"), null);
  });
  test("codes de secours : 10 codes distincts, sans caractère ambigu", () => {
    const codes = totp.generateRecoveryCodes();
    assert.equal(new Set(codes).size, 10);
    codes.forEach((c) => assert.match(c, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/));
    assert.equal(totp.hashRecovery("abcd efgh"), totp.hashRecovery(RECOVERY));
  });
});

describe("Double authentification : connexion", () => {
  afterEach(() => { mock.restoreAll(); throttle.reset(); });

  test("mot de passe correct : pas de jeton de session, une étape « code »", async () => {
    mock.method(User, "findOne", async () => admin());
    const res = await request(app).post("/api/auth/login").send({ email: "equipe@isd.ci", password: "Demo1234", role: "family" });
    assert.equal(res.status, 200);
    assert.equal(res.body.twoFactorRequired, true);
    assert.equal(res.body.token, undefined);
    assert.ok(res.body.challenge);
  });

  test("le jeton d'étape ne peut pas servir de session", async () => {
    const challenge = twoFactor.signChallenge(admin());
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${challenge}`);
    assert.equal(res.status, 401);
  });

  test("bon code : session vérifiée (mfa) ; même code rejoué : refusé", async () => {
    const doc = admin();
    mock.method(User, "findById", () => query(doc));
    const updates = [];
    mock.method(User, "updateOne", async (filter, change) => {
      updates.push({ filter, change });
      const step = change.$set?.["twoFactor.lastStep"];
      if (step === undefined || filter["twoFactor.lastStep"].$lt <= doc.twoFactor.lastStep) return { modifiedCount: 0 };
      doc.twoFactor.lastStep = step;
      return { modifiedCount: 1 };
    });
    const challenge = twoFactor.signChallenge(doc, { team: true });
    const code = now();
    const ok = await request(app).post("/api/auth/login/2fa").send({ challenge, code });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(jwt.decode(ok.body.token).mfa, true);
    assert.equal(ok.body.user.twoFactorEnabled, true);
    const again = await request(app).post("/api/auth/login/2fa").send({ challenge, code });
    assert.equal(again.status, 401);
  });

  test("code faux : refusé ; 5 codes faux : bloqué", async () => {
    mock.method(User, "findById", () => query(admin()));
    mock.method(User, "updateOne", async () => ({ modifiedCount: 0 }));
    const challenge = twoFactor.signChallenge(admin());
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await request(app).post("/api/auth/login/2fa").send({ challenge, code: "000000" })).status, 401);
    }
    assert.equal((await request(app).post("/api/auth/login/2fa").send({ challenge, code: now() })).status, 429);
  });

  test("code de secours : accepté une fois, puis retiré", async () => {
    const doc = admin();
    mock.method(User, "findById", () => query(doc));
    const pulls = [];
    mock.method(User, "updateOne", async (filter, change) => { pulls.push(change.$pull); return { modifiedCount: 1 }; });
    const res = await request(app).post("/api/auth/login/2fa").send({ challenge: twoFactor.signChallenge(doc), code: "abcd-efgh" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.recoveryCodesLeft, 0);
    assert.deepEqual(pulls[0], { "twoFactor.recoveryCodes": totp.hashRecovery(RECOVERY) });
  });

  test("jeton d'étape expiré ou falsifié : refusé", async () => {
    const forged = jwt.sign({ id: ID }, process.env.JWT_SECRET);
    const res = await request(app).post("/api/auth/login/2fa").send({ challenge: forged, code: now() });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "CHALLENGE_EXPIRED");
  });
});

describe("Double authentification : Espace ISD", () => {
  const prev = process.env.ADMIN_2FA;
  beforeEach(() => { delete process.env.ADMIN_2FA; });
  afterEach(() => { mock.restoreAll(); throttle.reset(); if (prev === undefined) delete process.env.ADMIN_2FA; else process.env.ADMIN_2FA = prev; });
  const adminCall = (token) => request(app).get("/api/admin/reviews").set("Authorization", `Bearer ${token}`);

  test("activée mais session ouverte sans code : 401 2FA_REQUIRED", async () => {
    mock.method(User, "findById", () => query({ isAdmin: true, twoFactorEnabled: true }));
    const res = await adminCall(tokenFor(ID, "family"));
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "2FA_REQUIRED");
  });

  test("obligatoire (production) et pas encore activée : 403 2FA_SETUP_REQUIRED", async () => {
    process.env.ADMIN_2FA = "required";
    mock.method(User, "findById", () => query({ isAdmin: true, twoFactorEnabled: false }));
    const res = await adminCall(tokenFor(ID, "family"));
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "2FA_SETUP_REQUIRED");
  });

  test("le statut et l'activation sont réservés à l'équipe ISD", async () => {
    mock.method(User, "findById", () => query({ _id: ID, isAdmin: false }));
    const res = await request(app).get("/api/auth/2fa").set("Authorization", `Bearer ${tokenFor(ID, "family")}`);
    assert.equal(res.status, 403);
  });

  test("activation : mot de passe exigé, puis bon code → codes de secours + session vérifiée", async () => {
    const doc = admin({ twoFactorEnabled: false, twoFactor: undefined });
    mock.method(User, "findById", () => query(doc));
    mock.method(User, "updateOne", async (filter, change) => {
      if (change.$set?.["twoFactor.pendingSecret"]) doc.twoFactor = { pendingSecret: change.$set["twoFactor.pendingSecret"] };
      return { modifiedCount: 1 };
    });
    mock.method(AdminLog, "create", async () => ({}));
    const auth = `Bearer ${tokenFor(ID, "family")}`;
    assert.equal((await request(app).post("/api/auth/2fa/setup").set("Authorization", auth).send({ password: "Faux1234" })).status, 401);
    const setup = await request(app).post("/api/auth/2fa/setup").set("Authorization", auth).send({ password: "Demo1234" });
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    assert.match(setup.body.qr, /^data:image\/png;base64,/);
    assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\/ISD/);
    assert.equal((await request(app).post("/api/auth/2fa/enable").set("Authorization", auth).send({ code: "000000" })).status, 400);
    const code = totp.codeAt(setup.body.secret, totp.stepAt());
    const on = await request(app).post("/api/auth/2fa/enable").set("Authorization", auth).send({ code });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.recoveryCodes.length, 10);
    assert.equal(jwt.decode(on.body.token).mfa, true);
  });

  test("le profil renvoyé par /auth/me ne contient jamais la clé", async () => {
    // select: false sur le schéma : vérifié directement sur la définition.
    assert.equal(User.schema.path("twoFactor").options.select, false);
  });
});
