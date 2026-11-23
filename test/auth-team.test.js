const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { buildApp } = require("./helpers");
const throttle = require("../services/loginThrottle");

const app = buildApp();
const HASH = bcrypt.hashSync("Demo1234", 4);
const user = (extra) => ({ _id: "64b0000000000000000000a1", email: "a@isd.ci", role: "family", password: HASH, firstName: "Jean", lastName: "A", ...extra });
const login = (body) => request(app).post("/api/auth/login").send(body);

describe("Connexion « Équipe ISD »", () => {
  afterEach(() => { mock.restoreAll(); throttle.reset(); });

  test("administrateur : connexion acceptée quel que soit son profil", async () => {
    mock.method(User, "findOne", async () => user({ isAdmin: true, role: "tutor" }));
    const res = await login({ email: "a@isd.ci", password: "Demo1234", role: "team" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.token);
    assert.equal(res.body.user.isAdmin, true);
  });

  test("compte sans droits d'administration : refusé (403), aucun jeton", async () => {
    mock.method(User, "findOne", async () => user({ isAdmin: false }));
    const res = await login({ email: "a@isd.ci", password: "Demo1234", role: "team" });
    assert.equal(res.status, 403);
    assert.equal(res.body.token, undefined);
  });

  test("mauvais mot de passe : refusé avant toute indication sur les droits", async () => {
    mock.method(User, "findOne", async () => user({ isAdmin: true }));
    const res = await login({ email: "a@isd.ci", password: "Faux1234", role: "team" });
    assert.equal(res.status, 401);
    assert.equal(res.body.token, undefined);
  });

  test("la vérification du profil reste active pour les connexions normales", async () => {
    mock.method(User, "findOne", async () => user({ isAdmin: true }));
    assert.equal((await login({ email: "a@isd.ci", password: "Demo1234", role: "nanny" })).status, 403);
  });
});
