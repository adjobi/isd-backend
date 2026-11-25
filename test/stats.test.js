const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const Visit = require("../models/Visit");
const User = require("../models/User");
const { buildApp, tokenFor } = require("./helpers");
const audience = require("../services/audience");
const stats = require("../services/stats");

const app = buildApp();
const UA = "Mozilla/5.0 (Linux; Android 13) Mobile";

describe("Mesure d'audience", () => {
  afterEach(() => mock.restoreAll());

  test("origine : utm, moteurs, réseaux, accès direct", () => {
    assert.equal(audience.sourceOf({ utm: "Facebook_Ads" }), "facebook_ads");
    assert.equal(audience.sourceOf({ ref: "https://www.google.ci/" }), "google");
    assert.equal(audience.sourceOf({ ref: "https://l.facebook.com/x" }), "facebook");
    assert.equal(audience.sourceOf({ ref: "https://isd.ci/nounou/", host: "isd.ci" }), "direct");
    assert.equal(audience.sourceOf({ ref: "" }), "direct");
    assert.equal(audience.sourceOf({ ref: "https://exemple.org/" }), "autre");
  });

  test("chemin : sans paramètres, limité", () => {
    assert.equal(audience.cleanPath("/app/?inscription=famille&tel=0700000000"), "/app/");
    assert.equal(audience.cleanPath("x".repeat(300)).length, 120);
  });

  test("page vue enregistrée sans IP ni paramètre ; robots ignorés", async () => {
    const saved = [];
    mock.method(Visit, "create", async (doc) => { saved.push(doc); return doc; });
    const ok = await request(app).post("/api/public/visit").set("User-Agent", UA).send({ kind: "site", path: "/nounou/cocody/?x=1", ref: "https://www.google.com/" });
    assert.equal(ok.status, 204);
    await request(app).post("/api/public/visit").set("User-Agent", "Googlebot/2.1").send({ kind: "site", path: "/" });
    await request(app).post("/api/public/visit").set("User-Agent", UA).send({ kind: "pirate" });
    assert.equal(saved.length, 1);
    const v = saved[0];
    assert.equal(v.path, "/nounou/cocody/");
    assert.equal(v.source, "google");
    assert.equal(v.device, "mobile");
    assert.match(v.visitor, /^[0-9a-f]{16}$/);
    assert.ok(!JSON.stringify(v).includes("127.0.0.1") && !JSON.stringify(v).includes("::ffff"));
  });

  test("même visiteur le même jour : même empreinte ; autre navigateur : autre empreinte", async () => {
    const saved = [];
    mock.method(Visit, "create", async (doc) => { saved.push(doc); return doc; });
    const body = { kind: "app", path: "/Landing" };
    await audience.recordVisit({ body, ip: "1.2.3.4", ua: UA });
    await audience.recordVisit({ body, ip: "1.2.3.4", ua: UA });
    await audience.recordVisit({ body, ip: "1.2.3.4", ua: `${UA} Autre` });
    assert.equal(saved[0].visitor, saved[1].visitor);
    assert.notEqual(saved[0].visitor, saved[2].visitor);
  });
});

describe("Tableau de bord", () => {
  afterEach(() => mock.restoreAll());

  test("périodes : 30 jours (jours) et 12 mois (mois), période précédente de même durée", () => {
    const now = new Date("2026-11-25T10:00:00Z");
    const d = stats.range("30d", now);
    assert.equal(d.buckets.length, 30);
    assert.equal(d.buckets[0], "2026-10-27");
    assert.equal(d.buckets[29], "2026-11-25");
    assert.equal(d.start.getTime() - d.prevStart.getTime(), 30 * 24 * 3600 * 1000);
    const m = stats.range("12m", now);
    assert.equal(m.unit, "month");
    assert.deepEqual([m.buckets[0], m.buckets[11]], ["2025-12", "2026-11"]);
    assert.equal(stats.range("n'importe", now).period, "30d");
  });

  test("réservé à l'équipe ISD", async () => {
    mock.method(User, "findById", () => ({ select: () => ({ lean: async () => ({ isAdmin: false }) }) }));
    const res = await request(app).get("/api/admin/stats").set("Authorization", `Bearer ${tokenFor("64b0000000000000000000a1", "family")}`);
    assert.equal(res.status, 403);
  });
});
