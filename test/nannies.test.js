const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const User = require("../models/User");
const { tokenFor, buildApp, chain } = require("./helpers");

const app = buildApp();
const FAMILY = tokenFor("64b000000000000000000001", "family");
const NANNY = tokenFor("64b000000000000000000002", "nanny");

describe("GET /api/nannies — recherche de prestataires", () => {
  afterEach(() => mock.restoreAll());

  test("refuse un visiteur non connecté (401)", async () => {
    const find = mock.method(User, "find", () => chain([], {}));
    const res = await request(app).get("/api/nannies?city=Abidjan");
    assert.equal(res.status, 401);
    assert.equal(find.mock.callCount(), 0);
  });

  test("refuse un prestataire (403) : réservé aux familles", async () => {
    const find = mock.method(User, "find", () => chain([], {}));
    const res = await request(app).get("/api/nannies?city=Abidjan").set("Authorization", `Bearer ${NANNY}`);
    assert.equal(res.status, 403);
    assert.equal(find.mock.callCount(), 0);
  });

  test("ne demande jamais téléphone, email ni mot de passe à la base", async () => {
    const calls = {};
    mock.method(User, "find", () => chain([{ firstName: "Aya" }], calls));
    const res = await request(app).get("/api/nannies?city=Abidjan").set("Authorization", `Bearer ${FAMILY}`);
    assert.equal(res.status, 200);
    const fields = calls.select.split(/\s+/);
    for (const forbidden of ["phone", "email", "password", "-password"]) {
      assert.ok(!fields.includes(forbidden), `champ interdit sélectionné : ${forbidden}`);
    }
    assert.ok(fields.includes("pricingAmount"));
  });

  test("exige une ville (400)", async () => {
    const res = await request(app).get("/api/nannies").set("Authorization", `Bearer ${FAMILY}`);
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.city);
  });

  test("bloque l'injection d'opérateur MongoDB via ?type[$ne]= (400)", async () => {
    const find = mock.method(User, "find", () => chain([], {}));
    const res = await request(app).get("/api/nannies?city=Abidjan&type[$ne]=family").set("Authorization", `Bearer ${FAMILY}`);
    assert.equal(res.status, 400);
    assert.equal(find.mock.callCount(), 0);
  });

  test("bloque une ville envoyée sous forme d'objet (400)", async () => {
    const res = await request(app).get("/api/nannies?city[$gt]=").set("Authorization", `Bearer ${FAMILY}`);
    assert.equal(res.status, 400);
  });

  test("échappe les caractères d'expression régulière dans la ville", async () => {
    let filter;
    mock.method(User, "find", (f) => { filter = f; return chain([], {}); });
    const res = await request(app).get("/api/nannies?city=" + encodeURIComponent("(a+)+$")).set("Authorization", `Bearer ${FAMILY}`);
    assert.equal(res.status, 200);
    assert.equal(filter.city.$regex, "\\(a\\+\\)\\+\\$");
    assert.deepEqual(filter.role, { $in: ["nanny", "tutor"] });
  });

  test("filtre type et prix, et plafonne la limite à 50", async () => {
    let filter; const calls = {};
    mock.method(User, "find", (f) => { filter = f; return chain([], calls); });
    const res = await request(app)
      .get("/api/nannies?city=Abidjan&type=tutor&minPrice=1000&maxPrice=5000&limit=500")
      .set("Authorization", `Bearer ${FAMILY}`);
    assert.equal(res.status, 200);
    assert.equal(filter.role, "tutor");
    assert.deepEqual(filter.pricingAmount, { $gte: 1000, $lte: 5000 });
    assert.equal(calls.limit, 50);
  });

  test("rejette un prix non numérique (400)", async () => {
    const res = await request(app).get("/api/nannies?city=Abidjan&maxPrice=abc").set("Authorization", `Bearer ${FAMILY}`);
    assert.equal(res.status, 400);
  });
});

describe("Noms des prestataires avant paiement (initiale)", () => {
  afterEach(() => mock.restoreAll());

  test("recherche : nom réduit à l'initiale, prénom conservé", async () => {
    mock.method(User, "find", () => chain([{ firstName: "Aya", lastName: "Kouassi" }, { firstName: "Awa", lastName: "" }], {}));
    const res = await request(app).get("/api/nannies?city=Abidjan").set("Authorization", `Bearer ${FAMILY}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((p) => [p.firstName, p.lastName]), [["Aya", "K."], ["Awa", ""]]);
  });

  test("réservations (ancien parcours) : profil public seulement, nom à l'initiale", async () => {
    const Booking = require("../models/Booking");
    const ctrl = require("../controllers/bookingController");
    let fields;
    mock.method(Booking, "find", () => ({
      populate(path, f) { fields = f; return Promise.resolve([{ toObject: () => ({ _id: "b1", providerId: { firstName: "Aya", lastName: "Kouassi" } }) }]); },
    }));
    let body;
    await ctrl.getFamilyBookings({ user: { id: "64b000000000000000000001" } }, { json: (b) => { body = b; }, status() { return this; } });
    for (const forbidden of ["phone", "email", "password"]) assert.ok(!fields.split(/\s+/).includes(forbidden), forbidden);
    assert.equal(body[0].providerId.lastName, "K.");
  });
});
