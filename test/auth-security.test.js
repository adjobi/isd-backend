const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Invoice = require("../models/Invoice");
const { buildApp, chain } = require("./helpers");
const throttle = require("../services/loginThrottle");
const { registerLimiter } = require("../routes/authRoutes");

const app = buildApp();
const HASH = bcrypt.hashSync("Demo1234", 4);
const ADMIN_ID = "64b0000000000000000000a1";
const user = (extra) => ({ _id: ADMIN_ID, email: "a@isd.ci", role: "family", password: HASH, firstName: "Jean", lastName: "A", ...extra });
const login = (body) => request(app).post("/api/auth/login").send(body);

describe("Connexion : message unique", () => {
  afterEach(() => { mock.restoreAll(); throttle.reset(); });

  test("email inconnu et mauvais mot de passe donnent exactement la même réponse", async () => {
    mock.method(User, "findOne", async () => null);
    const unknown = await login({ email: "personne@isd.ci", password: "Demo1234" });
    mock.restoreAll();
    mock.method(User, "findOne", async () => user());
    const wrong = await login({ email: "a@isd.ci", password: "Faux1234" });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.deepEqual(unknown.body, wrong.body);
    assert.equal(unknown.body.message, "Email ou mot de passe incorrect.");
  });

  test("le mauvais profil n'est signalé qu'après un mot de passe correct", async () => {
    mock.method(User, "findOne", async () => user({ role: "nanny" }));
    assert.equal((await login({ email: "a@isd.ci", password: "Faux1234", role: "family" })).status, 401);
    assert.equal((await login({ email: "a@isd.ci", password: "Demo1234", role: "family" })).status, 403);
  });
});

describe("Connexion : limite de tentatives", () => {
  afterEach(() => { mock.restoreAll(); throttle.reset(); });

  test(`compte bloqué après ${throttle.MAX_PER_EMAIL} échecs, même avec le bon mot de passe`, async () => {
    mock.method(User, "findOne", async () => user());
    for (let i = 0; i < throttle.MAX_PER_EMAIL; i += 1) {
      assert.equal((await login({ email: "a@isd.ci", password: "Faux1234" })).status, 401);
    }
    const blocked = await login({ email: "a@isd.ci", password: "Demo1234" });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.message, /Trop de tentatives/);
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
    assert.equal(blocked.body.token, undefined);
  });

  test("une connexion réussie remet le compteur de l'email à zéro", async () => {
    mock.method(User, "findOne", async () => user());
    for (let i = 0; i < throttle.MAX_PER_EMAIL - 1; i += 1) await login({ email: "a@isd.ci", password: "Faux1234" });
    assert.equal((await login({ email: "a@isd.ci", password: "Demo1234" })).status, 200);
    assert.equal((await login({ email: "a@isd.ci", password: "Faux1234" })).status, 401);
  });

  test("le blocage se lève à la fin de la fenêtre", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < throttle.MAX_PER_EMAIL; i += 1) throttle.failure("b@isd.ci", t0);
    assert.ok(throttle.check("1.2.3.4", "b@isd.ci", t0 + 1000) > 0);
    assert.equal(throttle.check("1.2.3.4", "b@isd.ci", t0 + throttle.WINDOW_MS + 1), 0);
  });

  test("inscriptions limitées par connexion (429 au-delà de 10 par heure)", async () => {
    registerLimiter.reset();
    let last;
    for (let i = 0; i < 11; i += 1) last = await request(app).post("/api/auth/register").send({});
    assert.equal(last.status, 429);
    registerLimiter.reset();
  });
});

describe("Session d'administration courte", () => {
  afterEach(() => { mock.restoreAll(); throttle.reset(); });

  test("connexion « Équipe ISD » : jeton valable 12 h", async () => {
    mock.method(User, "findOne", async () => user({ isAdmin: true }));
    const res = await login({ email: "a@isd.ci", password: "Demo1234", role: "team" });
    const { iat, exp } = jwt.decode(res.body.token);
    assert.equal(exp - iat, 12 * 3600);
  });

  test("un jeton de plus de 12 h n'ouvre plus l'Espace ISD (401)", async () => {
    mock.method(User, "findById", () => chain({ isAdmin: true }, {}));
    mock.method(Invoice, "find", () => chain([], {}));
    mock.method(Invoice, "countDocuments", async () => 0);
    const iat = Math.floor(Date.now() / 1000) - 13 * 3600;
    const old = jwt.sign({ id: ADMIN_ID, role: "family", iat }, process.env.JWT_SECRET, { expiresIn: "7d" });
    const fresh = jwt.sign({ id: ADMIN_ID, role: "family" }, process.env.JWT_SECRET, { expiresIn: "7d" });
    const denied = await request(app).get("/api/admin/payments").set("Authorization", `Bearer ${old}`);
    assert.equal(denied.status, 401);
    assert.match(denied.body.message, /reconnectez-vous/);
    const ok = await request(app).get("/api/admin/payments").set("Authorization", `Bearer ${fresh}`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });
});
