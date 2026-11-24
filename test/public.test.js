const { test, describe, afterEach, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const User = require("../models/User");
const Setting = require("../models/Setting");
const publicRoutes = require("../routes/publicRoutes");
const { buildApp } = require("./helpers");

const app = buildApp();
const q = (doc) => {
  const o = { select: () => o, sort: () => o, limit: () => o, lean: async () => doc };
  return o;
};
const PROVIDER = {
  _id: "64b0000000000000000000c1", role: "nanny", serviceType: "nanny", firstName: "Adjoua Marie", lastName: "Kouassi",
  phone: "0701020304", email: "adjoua@x.ci", photo: "data:image/png;base64,AAAA", commune: "Cocody", city: "Abidjan",
  pricingType: "month", pricingAmount: 60000, rating: 4.5, availability: "available", isVerified: true,
  bio: "Douce et patiente, 5 ans d'expérience avec les tout-petits.", skills: ["Premiers secours", "Cuisine"], createdAt: new Date(),
};

describe("Vitrine publique", () => {
  beforeEach(() => { publicRoutes.clearCache(); publicRoutes.publicLimiter.reset(); });
  afterEach(() => mock.restoreAll());

  test("profils sans aucune coordonnée, nom réduit à l'initiale", async () => {
    let filter;
    mock.method(User, "find", (f) => { filter = f; return q([PROVIDER]); });
    mock.method(User, "countDocuments", async () => 1);
    const res = await request(app).get("/api/public/providers?service=nanny&commune=cocody");
    assert.equal(res.status, 200);
    const p = res.body.providers[0];
    assert.equal(p.firstName, "Adjoua");
    assert.equal(p.initial, "K");
    for (const k of ["phone", "email", "photo", "lastName"]) assert.equal(p[k], undefined, k);
    assert.ok(!JSON.stringify(res.body).includes("0701020304"));
    assert.deepEqual(filter.role, { $in: ["nanny"] });
    assert.ok(filter.commune.test("Cocody"));
    assert.equal(res.body.total, 1);
  });

  test("présentation contenant des coordonnées : masquée", async () => {
    mock.method(User, "find", () => q([{ ...PROVIDER, bio: "Appelez-moi au 07 01 02 03 04 ou sur WhatsApp" }]));
    mock.method(User, "countDocuments", async () => 1);
    const res = await request(app).get("/api/public/providers");
    assert.equal(res.body.providers[0].bio, "");
  });

  test("filtre de commune échappé, limite plafonnée", async () => {
    let filter;
    mock.method(User, "find", (f) => { filter = f; return q([]); });
    mock.method(User, "countDocuments", async () => 0);
    const res = await request(app).get("/api/public/providers?commune=.*&limit=999");
    assert.equal(res.status, 200);
    assert.equal(filter.commune.test("Cocody"), false);
  });

  test("résumé : totaux par service et par commune, tarifs", async () => {
    mock.method(User, "aggregate", async () => [
      { _id: { role: "nanny", commune: "Cocody" }, n: 3 },
      { _id: { role: "tutor", commune: "Cocody" }, n: 2 },
      { _id: { role: "tutor", commune: "" }, n: 1 },
    ]);
    mock.method(Setting, "findOne", () => q(null));
    const res = await request(app).get("/api/public/summary");
    assert.deepEqual(res.body.totals, { nanny: 3, tutor: 3 });
    assert.deepEqual(res.body.communes.Cocody, { nanny: 3, tutor: 2 });
    assert.equal(res.body.pricing.ratePercent, 20);
    assert.equal(res.body.pricing.guaranteeDays, 30);
  });
});
