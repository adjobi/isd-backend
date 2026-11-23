const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const User = require("../models/User");
const { tokenFor, buildApp } = require("./helpers");

const app = buildApp();
const ID = "64b000000000000000000002";
const NANNY = tokenFor(ID, "nanny");
const TUTOR = tokenFor(ID, "tutor");
const FAMILY = tokenFor(ID, "family");

// Images minimales valides (en-têtes réels JPEG / PNG)
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString("base64")}`;
const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString("base64")}`;

// Imite findByIdAndUpdate().select().lean() et mémorise la mise à jour reçue.
const mockUpdate = () => {
  const seen = {};
  const fn = mock.method(User, "findByIdAndUpdate", (id, update, opts) => {
    Object.assign(seen, { id, update, opts });
    const q = { select: () => q, lean: async () => ({ _id: id, role: "nanny", ...update.$set }) };
    return q;
  });
  return { fn, seen };
};
const put = (token, body) => request(app).put("/api/auth/profile").set("Authorization", `Bearer ${token}`).send(body);

describe("PUT /api/auth/profile", () => {
  afterEach(() => mock.restoreAll());

  test("refuse sans connexion (401)", async () => {
    const { fn } = mockUpdate();
    const res = await request(app).put("/api/auth/profile").send({ bio: "Bonjour" });
    assert.equal(res.status, 401);
    assert.equal(fn.mock.callCount(), 0);
  });

  test("met à jour un profil nounou complet et renvoie le profil sans mot de passe", async () => {
    const { seen } = mockUpdate();
    const res = await put(NANNY, {
      firstName: "  Aya   Marie ", lastName: "Kouassi", phone: "07 12 34 56 78", city: "Abidjan", commune: "Cocody",
      bio: "Nounou depuis 8 ans.", skills: ["Cuisine", "Cuisine", " Premiers secours "], values: ["Ponctualité"],
      pricingType: "month", pricingAmount: 65000, availability: "busy", photo: JPEG,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const s = seen.update.$set;
    assert.equal(seen.id, ID);
    assert.equal(s.firstName, "Aya Marie");
    assert.equal(s.phone, "+2250712345678");
    assert.deepEqual(s.skills, ["Cuisine", "Premiers secours"]);
    assert.equal(s.pricingAmount, 65000);
    assert.ok(s.photo.startsWith("data:image/jpeg;base64,"));
    assert.equal(seen.opts.runValidators, true);
    assert.equal(res.body.user.password, undefined);
  });

  test("ignore les champs protégés (rôle, note, vérification, email, mot de passe)", async () => {
    const { seen } = mockUpdate();
    const res = await put(NANNY, { bio: "Bonjour", role: "family", rating: 5, isVerified: true, email: "x@y.ci", password: "abc" });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(seen.update.$set), ["bio"]);
  });

  test("accepte une photo PNG et la suppression de la photo", async () => {
    mockUpdate();
    assert.equal((await put(FAMILY, { photo: PNG })).status, 200);
    assert.equal((await put(FAMILY, { photo: "" })).status, 200);
  });

  test("refuse une photo qui n'est pas une vraie image (400)", async () => {
    const { fn } = mockUpdate();
    const fake = `data:image/jpeg;base64,${Buffer.from("<script>alert(1)</script>").toString("base64")}`;
    for (const photo of [fake, "https://exemple.com/a.jpg", "data:image/svg+xml;base64,PHN2Zz4=", 42]) {
      const res = await put(NANNY, { photo });
      assert.equal(res.status, 400, String(photo).slice(0, 30));
      assert.ok(res.body.errors.photo);
    }
    assert.equal(fn.mock.callCount(), 0);
  });

  test("refuse une photo de plus de 300 Ko (400) et un corps trop gros (413)", async () => {
    mockUpdate();
    const big = Buffer.alloc(310 * 1024); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
    const res = await put(NANNY, { photo: `data:image/jpeg;base64,${big.toString("base64")}` });
    assert.equal(res.status, 400);
    assert.match(res.body.errors.photo, /300 Ko/);
    const huge = await put(NANNY, { bio: "a".repeat(500 * 1024) });
    assert.equal(huge.status, 413);
    assert.match(huge.body.message, /volumineuses/);
  });

  test("refuse les coordonnées dans les textes publics (400)", async () => {
    const { fn } = mockUpdate();
    const cases = [
      { bio: "Appelez-moi au 07 12 34 56 78" },
      { bio: "Écrivez à aya.k@gmail.com" },
      { bio: "Retrouvez-moi sur WhatsApp" },
      { bio: "Mon profil : www.aya-nounou.ci" },
      { bio: "Insta @aya_nounou" },
      { skills: ["Cuisine", "facebook aya"] },
    ];
    for (const body of cases) {
      const res = await put(NANNY, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(JSON.stringify(res.body.errors), /coordonnées/);
    }
    assert.equal(fn.mock.callCount(), 0);
  });

  test("accepte un texte normal avec des montants et des âges", async () => {
    mockUpdate();
    const res = await put(NANNY, { bio: "J’ai gardé des enfants de 2 à 10 ans pendant 8 ans, tarif 60 000 FCFA négociable." });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  test("valide téléphone, nom, tarif, unité et disponibilité (400)", async () => {
    const { fn } = mockUpdate();
    const res = await put(NANNY, {
      phone: "0812345678", firstName: "", lastName: "K0uassi", pricingAmount: 50, pricingType: "session", availability: "vacances",
    });
    assert.equal(res.status, 400);
    for (const f of ["phone", "firstName", "lastName", "pricingAmount", "pricingType", "availability"]) {
      assert.ok(res.body.errors[f], `erreur attendue sur ${f}`);
    }
    assert.equal(fn.mock.callCount(), 0);
  });

  test("refuse les champs prestataire pour une famille et les matières hors répétiteur (400)", async () => {
    const { fn } = mockUpdate();
    const fam = await put(FAMILY, { pricingAmount: 50000, skills: ["Cuisine"] });
    assert.equal(fam.status, 400);
    assert.ok(fam.body.errors.pricingAmount && fam.body.errors.skills);
    const nanny = await put(NANNY, { subjects: ["Maths"] });
    assert.equal(nanny.status, 400);
    assert.equal(fn.mock.callCount(), 0);
  });

  test("répétiteur : matières obligatoires et unité « séance » acceptée", async () => {
    mockUpdate();
    assert.equal((await put(TUTOR, { subjects: [] })).status, 400);
    const ok = await put(TUTOR, { subjects: ["Mathématiques", "SVT"], pricingType: "session", pricingAmount: 7000 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  test("refuse une requête vide (400) et les injections d'opérateurs", async () => {
    const { fn } = mockUpdate();
    assert.equal((await put(NANNY, {})).status, 400);
    assert.equal((await put(NANNY, { bio: { $gt: "" } })).status, 400);
    assert.equal(fn.mock.callCount(), 0);
  });

  test("masque les erreurs techniques (500 générique)", async () => {
    mock.method(User, "findByIdAndUpdate", () => { throw new Error("connexion Mongo perdue"); });
    mock.method(console, "error", () => {});
    const res = await put(NANNY, { bio: "Bonjour" });
    assert.equal(res.status, 500);
    assert.doesNotMatch(res.body.message, /Mongo/);
  });
});

describe("GET /api/auth/me", () => {
  afterEach(() => mock.restoreAll());

  test("renvoie le profil complet depuis la base, sans mot de passe", async () => {
    let selected;
    mock.method(User, "findById", () => {
      const q = { select: (s) => { selected = s; return q; }, lean: async () => ({ _id: ID, firstName: "Aya", phone: "+2250700000002", photo: JPEG }) };
      return q;
    });
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${NANNY}`);
    assert.equal(res.status, 200);
    assert.equal(selected, "-password");
    assert.equal(res.body.user.firstName, "Aya");
    assert.equal(res.body.user.id, ID);
  });

  test("404 si le compte n'existe plus", async () => {
    mock.method(User, "findById", () => { const q = { select: () => q, lean: async () => null }; return q; });
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${NANNY}`);
    assert.equal(res.status, 404);
  });
});
