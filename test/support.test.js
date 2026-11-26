const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const SupportRequest = require("../models/SupportRequest");
const User = require("../models/User");
const Notification = require("../models/Notification");
const AdminLog = require("../models/AdminLog");
const { buildApp, tokenFor } = require("./helpers");

const app = buildApp();
const FAMILY = "64b0000000000000000000f1";
const ADMIN = "64b0000000000000000000a1";
const auth = (id, role = "family") => `Bearer ${tokenFor(id, role)}`;
const lean = (v) => ({ select: () => ({ lean: async () => v }), lean: async () => v });

describe("Aide et contact", () => {
  const prev = { wa: process.env.WHATSAPP_ISD, mail: process.env.CONTACT_EMAIL };
  afterEach(() => {
    mock.restoreAll();
    process.env.WHATSAPP_ISD = prev.wa || "";
    process.env.CONTACT_EMAIL = prev.mail || "";
  });

  test("coordonnées publiques : numéro au format ivoirien seulement", async () => {
    process.env.WHATSAPP_ISD = "225 07 09 10 25 24";
    process.env.CONTACT_EMAIL = "contact@isd.ci";
    const res = await request(app).get("/api/public/contact");
    assert.deepEqual(res.body, { whatsapp: "2250709102524", whatsappDisplay: "+225 07 09 10 25 24", email: "contact@isd.ci" });
    process.env.WHATSAPP_ISD = "123";
    assert.equal((await request(app).get("/api/public/contact")).body.whatsapp, null);
  });

  test("demande : connexion obligatoire, sujet et message validés", async () => {
    assert.equal((await request(app).post("/api/support").send({ topic: "payment", message: "Bonjour, question" })).status, 401);
    const bad = await request(app).post("/api/support").set("Authorization", auth(FAMILY)).send({ topic: "x", message: "court" });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.errors.topic && bad.body.errors.message);
  });

  test("demande envoyée : enregistrée et équipe ISD prévenue", async () => {
    mock.method(SupportRequest, "countDocuments", async () => 0);
    mock.method(User, "findById", () => lean({ role: "family", firstName: "Awa" }));
    mock.method(User, "find", () => lean([{ _id: ADMIN }]));
    const created = [];
    mock.method(SupportRequest, "create", async (doc) => { created.push(doc); return { _id: "64b0000000000000000000s1", createdAt: new Date(), status: "open", ...doc }; });
    const notes = [];
    mock.method(Notification, "create", async (n) => { notes.push(n); return n; });
    const res = await request(app).post("/api/support").set("Authorization", auth(FAMILY)).send({ topic: "payment", message: "  Mon paiement Wave n'est pas encore validé  " });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(created[0].message, "Mon paiement Wave n'est pas encore validé");
    assert.equal(created[0].role, "family");
    assert.equal(String(notes[0].userId), ADMIN);
    assert.equal(notes[0].metadata.admin, true);
  });

  test("plus de 5 demandes par heure : refusé", async () => {
    mock.method(SupportRequest, "countDocuments", async () => 5);
    const res = await request(app).post("/api/support").set("Authorization", auth(FAMILY)).send({ topic: "other", message: "Encore une question pour vous" });
    assert.equal(res.status, 429);
  });

  test("réponse de l'équipe : notification à l'utilisateur, journal, pas sur sa propre demande", async () => {
    mock.method(User, "findById", () => lean({ isAdmin: true }));
    const doc = { _id: "64b0000000000000000000c1", user: FAMILY, topic: "payment", status: "open", save: async () => doc };
    mock.method(SupportRequest, "findById", async () => doc);
    const notes = [];
    mock.method(Notification, "create", async (n) => { notes.push(n); return n; });
    const logs = [];
    mock.method(AdminLog, "create", async (l) => { logs.push(l); return l; });
    const url = `/api/admin/support/${doc._id}/reply`;
    assert.equal((await request(app).post(url).set("Authorization", auth(ADMIN)).send({ text: "" })).status, 400);
    const ok = await request(app).post(url).set("Authorization", auth(ADMIN)).send({ text: "Votre paiement est validé, merci !" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(doc.status, "answered");
    assert.equal(String(notes[0].userId), FAMILY);
    assert.equal(notes[0].metadata.support, doc._id);
    assert.equal(logs[0].action, "support_replied");
    doc.user = ADMIN;
    assert.equal((await request(app).post(url).set("Authorization", auth(ADMIN)).send({ text: "Je me réponds" })).status, 403);
  });
});
