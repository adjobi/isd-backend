// Cas complémentaires « Aide et contact » : contrôles d'accès, validation, coordonnées publiques.
const { test, describe, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const SupportRequest = require("../models/SupportRequest");
const User = require("../models/User");
const Notification = require("../models/Notification");
const AdminLog = require("../models/AdminLog");
const { buildApp, tokenFor, chain } = require("./helpers");
const { supportLimiter } = require("../routes/supportRoutes");

const app = buildApp();
const FAMILY = "64b0000000000000000000f1";
const OTHER = "64b0000000000000000000f2";
const ADMIN = "64b0000000000000000000a1";
const auth = (id, role = "family") => `Bearer ${tokenFor(id, role)}`;
const lean = (v) => ({ select: () => ({ lean: async () => v }), lean: async () => v });
const isAdmin = (yes) => mock.method(User, "findById", () => lean(yes ? { isAdmin: true } : { isAdmin: false }));

describe("Aide et contact : cas complémentaires", () => {
  const prev = { wa: process.env.WHATSAPP_ISD, mail: process.env.CONTACT_EMAIL };
  beforeEach(() => supportLimiter.reset());
  afterEach(() => {
    mock.restoreAll();
    process.env.WHATSAPP_ISD = prev.wa || "";
    process.env.CONTACT_EMAIL = prev.mail || "";
  });

  test("GET /api/support : filtre sur MON identifiant, jamais celui d'un autre", async () => {
    const calls = {};
    let filter;
    mock.method(SupportRequest, "find", (f) => {
      filter = f;
      return chain([{ _id: "64b0000000000000000000c1", user: FAMILY, topic: "payment", message: "Question paiement", status: "answered", reply: { text: "Réglé", at: new Date(), by: ADMIN }, createdAt: new Date() }], calls);
    });
    const res = await request(app).get("/api/support").set("Authorization", auth(FAMILY));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(filter, { user: FAMILY });
    assert.equal(calls.limit, 20);
    assert.equal(res.body.requests[0].topicLabel, "Paiement");
    // La réponse ne divulgue ni l'auteur de la réponse ni l'utilisateur.
    assert.deepEqual(Object.keys(res.body.requests[0].reply).sort(), ["at", "text"]);
    assert.equal(res.body.requests[0].user, undefined);
  });

  test("GET /api/support : connexion obligatoire", async () => {
    assert.equal((await request(app).get("/api/support")).status, 401);
  });

  test("GET /api/support : erreur base → 500 avec message en français", async () => {
    mock.method(SupportRequest, "find", () => { throw new Error("db down"); });
    mock.method(console, "error", () => {});
    const res = await request(app).get("/api/support").set("Authorization", auth(FAMILY));
    assert.equal(res.status, 500);
    assert.match(res.body.message, /Impossible de charger/);
  });

  test("non-admin : 403 sur la liste et sur la réponse, rien n'est lu ni écrit", async () => {
    isAdmin(false);
    const find = mock.method(SupportRequest, "find", () => chain([], {}));
    const update = mock.method(SupportRequest, "findOneAndUpdate", () => chain(null, {}));
    const list = await request(app).get("/api/admin/support").set("Authorization", auth(OTHER));
    assert.equal(list.status, 403);
    const reply = await request(app).post("/api/admin/support/64b0000000000000000000c1/reply").set("Authorization", auth(OTHER)).send({ text: "Je réponds à sa place" });
    assert.equal(reply.status, 403);
    assert.equal(find.mock.callCount(), 0);
    assert.equal(update.mock.callCount(), 0);
  });

  test("non connecté : 401 sur /api/admin/support", async () => {
    assert.equal((await request(app).get("/api/admin/support")).status, 401);
  });

  test("réponse admin vide, blanche, d'1 caractère ou trop longue → 400 sans lecture", async () => {
    isAdmin(true);
    const update = mock.method(SupportRequest, "findOneAndUpdate", () => chain(null, {}));
    const url = "/api/admin/support/64b0000000000000000000c1/reply";
    for (const body of [{}, { text: "" }, { text: "    " }, { text: "a" }, { text: "x".repeat(1001) }, { text: 12345 }, { text: { $ne: null } }, { text: ["Bonjour"] }]) {
      const res = await request(app).post(url).set("Authorization", auth(ADMIN)).send(body);
      assert.equal(res.status, 400, `body=${JSON.stringify(body).slice(0, 40)} → ${res.status}`);
      assert.ok(res.body.errors?.text);
    }
    assert.equal(update.mock.callCount(), 0);
  });

  test("réponse admin de 1000 caractères exactement : acceptée, notification tronquée à 140", async () => {
    isAdmin(true);
    let set;
    mock.method(SupportRequest, "findOneAndUpdate", (f, u) => { set = u.$set; return chain({ _id: "64b0000000000000000000c1", user: FAMILY, topic: "other", ...u.$set }, {}); });
    const notes = [];
    mock.method(Notification, "create", async (n) => { notes.push(n); return n; });
    mock.method(AdminLog, "create", async (l) => l);
    const res = await request(app).post("/api/admin/support/64b0000000000000000000c1/reply").set("Authorization", auth(ADMIN)).send({ text: "y".repeat(1000) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(set.reply.text.length, 1000);
    assert.equal(String(set.reply.by), ADMIN);
    assert.equal(res.body.request.reply.text.length, 1000);
    assert.equal(notes[0].message.length, 140);
    assert.ok(notes[0].message.endsWith("…"));
  });

  test("répondre à un id invalide → 400 ; à un id inexistant → 404, rien de notifié", async () => {
    isAdmin(true);
    const update = mock.method(SupportRequest, "findOneAndUpdate", () => chain(null, {}));
    const byId = mock.method(SupportRequest, "findById", () => chain(null, {}));
    const notes = mock.method(Notification, "create", async (n) => n);
    const logs = mock.method(AdminLog, "create", async (l) => l);
    for (const bad of ["abc", "123", "64b0000000000000000000zz", "%7B%22%24ne%22%3Anull%7D"]) {
      const res = await request(app).post(`/api/admin/support/${bad}/reply`).set("Authorization", auth(ADMIN)).send({ text: "Bonjour, c'est réglé" });
      assert.equal(res.status, 400, `id=${bad}`);
    }
    assert.equal(byId.mock.callCount(), 0);
    const missing = await request(app).post("/api/admin/support/64b0000000000000000000ee/reply").set("Authorization", auth(ADMIN)).send({ text: "Bonjour, c'est réglé" });
    assert.equal(missing.status, 404);
    assert.equal(notes.mock.callCount(), 0);
    assert.equal(logs.mock.callCount(), 0);
  });

  test("filtre ?status : answered, open par défaut, valeur inconnue ou objet → open", async () => {
    isAdmin(true);
    const filters = [];
    const calls = {};
    mock.method(SupportRequest, "find", (f) => { filters.push(f); return chain([{ _id: "c1", topic: "account" }], calls); });
    mock.method(SupportRequest, "countDocuments", async () => 3);
    const get = (qs) => request(app).get(`/api/admin/support${qs}`).set("Authorization", auth(ADMIN));

    const answered = await get("?status=answered");
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(answered.body.status, "answered");
    assert.deepEqual(calls.sort, { createdAt: -1 });
    assert.equal(answered.body.open, 3);
    assert.equal(answered.body.requests[0].topicLabel, "Mon compte");

    const def = await get("");
    assert.equal(def.body.status, "open");
    assert.equal(def.body.open, 3);
    assert.deepEqual(calls.sort, { createdAt: 1 }); // les plus anciennes d'abord

    for (const qs of ["?status=closed", "?status[$ne]=open", "?status[]=answered&status[]=open"]) {
      const r = await get(qs);
      assert.equal(r.status, 200, qs);
      assert.equal(r.body.status, "open", qs);
      assert.equal(r.body.open, 3, qs);
    }
    for (const f of filters) assert.equal(typeof f.status, "string");
    assert.ok(calls.limit <= 100);
  });

  test("topic de type objet ({$ne:null}) ou tableau : 400, rien n'est écrit", async () => {
    const count = mock.method(SupportRequest, "countDocuments", async () => 0);
    const create = mock.method(SupportRequest, "create", async (d) => d);
    for (const topic of [{ $ne: null }, { $in: ["payment"] }, ["payment"], null, 1]) {
      const res = await request(app).post("/api/support").set("Authorization", auth(FAMILY)).send({ topic, message: "Une question tout à fait valide" });
      assert.equal(res.status, 400, `topic=${JSON.stringify(topic)}`);
      assert.ok(res.body.errors.topic);
    }
    // message objet aussi refusé
    const m = await request(app).post("/api/support").set("Authorization", auth(FAMILY)).send({ topic: "payment", message: { $gt: "" } });
    assert.equal(m.status, 400);
    assert.ok(m.body.errors.message);
    assert.equal(count.mock.callCount(), 0);
    assert.equal(create.mock.callCount(), 0);
  });

  test("message trop long (> 1000 après nettoyage) : 400", async () => {
    const res = await request(app).post("/api/support").set("Authorization", auth(FAMILY)).send({ topic: "other", message: "z".repeat(1001) });
    assert.equal(res.status, 400);
    assert.match(res.body.errors.message, /1000/);
  });

  test("GET /api/public/contact : WHATSAPP_ISD mal formé → null partout, pas de 500", async () => {
    process.env.CONTACT_EMAIL = "";
    for (const wa of ["", "0709102524", "+33 6 12 34 56 78", "225070910252", "22507091025245", "abc", "225 07 09 10 25 24 poste 5"]) {
      process.env.WHATSAPP_ISD = wa;
      const res = await request(app).get("/api/public/contact");
      assert.equal(res.status, 200, `wa=${wa}`);
      assert.equal(res.body.whatsapp, null, `wa=${wa}`);
      assert.equal(res.body.whatsappDisplay, null, `wa=${wa}`);
      assert.equal(res.body.email, null);
    }
    delete process.env.WHATSAPP_ISD;
    assert.equal((await request(app).get("/api/public/contact")).body.whatsapp, null);
  });

  test("GET /api/public/contact : formats tolérés (+225, tirets, points)", async () => {
    for (const wa of ["+225 07 09 10 25 24", "+225-07-09-10-25-24", "225.07.09.10.25.24"]) {
      process.env.WHATSAPP_ISD = wa;
      const res = await request(app).get("/api/public/contact");
      assert.equal(res.body.whatsapp, "2250709102524", wa);
      assert.equal(res.body.whatsappDisplay, "+225 07 09 10 25 24", wa);
    }
  });

  test("GET /api/public/contact : CONTACT_EMAIL mal formé → null ; espaces autour → nettoyé", async () => {
    process.env.WHATSAPP_ISD = "";
    for (const mail of ["contact", "contact@isd", "a b@isd.ci", "@isd.ci"]) {
      process.env.CONTACT_EMAIL = mail;
      assert.equal((await request(app).get("/api/public/contact")).body.email, null, mail);
    }
    for (const mail of ["  contact@isd.ci  ", " contact@isd.ci", "contact@isd.ci\n", "\tcontact@isd.ci "]) {
      process.env.CONTACT_EMAIL = mail;
      assert.equal((await request(app).get("/api/public/contact")).body.email, "contact@isd.ci", JSON.stringify(mail));
    }
  });
});
