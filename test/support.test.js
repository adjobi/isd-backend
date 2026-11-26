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
const ADMIN = "64b0000000000000000000a1";
const auth = (id, role = "family") => `Bearer ${tokenFor(id, role)}`;
const lean = (v) => ({ select: () => ({ lean: async () => v }), lean: async () => v });

describe("Aide et contact", () => {
  const prev = { wa: process.env.WHATSAPP_ISD, mail: process.env.CONTACT_EMAIL };
  beforeEach(() => supportLimiter.reset());
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

  test("demande envoyée : enregistrée, équipe ISD prévenue après la réponse (une seule écriture)", async () => {
    mock.method(SupportRequest, "countDocuments", async () => 0);
    mock.method(User, "findById", () => lean({ role: "family", firstName: "Awa" }));
    mock.method(User, "find", () => lean([{ _id: ADMIN }, { _id: "64b0000000000000000000a2" }]));
    const created = [];
    mock.method(SupportRequest, "create", async (doc) => { created.push(doc); return { _id: "64b0000000000000000000c9", createdAt: new Date(), status: "open", ...doc }; });
    let done;
    const inserted = new Promise((r) => { done = r; });
    const insert = mock.method(Notification, "insertMany", async (docs, opts) => { done({ docs, opts }); return docs; });
    const single = mock.method(Notification, "create", async (n) => n);
    const res = await request(app).post("/api/support").set("Authorization", auth(FAMILY)).send({ topic: "payment", message: "  Mon paiement Wave n'est pas encore validé  " });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(created[0].message, "Mon paiement Wave n'est pas encore validé");
    assert.equal(created[0].role, "family");
    const { docs, opts } = await inserted;
    assert.equal(insert.mock.callCount(), 1);
    assert.equal(single.mock.callCount(), 0);
    assert.deepEqual(opts, { ordered: false });
    assert.deepEqual(docs.map((n) => String(n.userId)), [ADMIN, "64b0000000000000000000a2"]);
    assert.equal(docs[0].metadata.admin, true);
    assert.equal(docs[0].metadata.support, "64b0000000000000000000c9");
  });

  test("notification aux admins : texte générique, jamais le contenu du message", async () => {
    const secret = "Mon numéro Orange Money 0700000000 a été débité deux fois";
    mock.method(SupportRequest, "countDocuments", async () => 0);
    mock.method(User, "findById", () => lean({ role: "nanny" }));
    mock.method(User, "find", () => lean([{ _id: ADMIN }]));
    mock.method(SupportRequest, "create", async (doc) => ({ _id: "64b0000000000000000000c8", createdAt: new Date(), status: "open", ...doc }));
    let done;
    const inserted = new Promise((r) => { done = r; });
    mock.method(Notification, "insertMany", async (docs) => { done(docs); return docs; });
    const res = await request(app).post("/api/support").set("Authorization", auth(FAMILY, "nanny")).send({ topic: "payment", message: secret });
    assert.equal(res.status, 201);
    const [note] = await inserted;
    assert.equal(note.message, "Nouvelle demande d'aide : Paiement");
    assert.ok(!JSON.stringify(note).includes("0700000000"));
    assert.ok(!JSON.stringify(note).includes("débité"));
  });

  test("échec de la notification admin : la demande reste envoyée (201), erreur journalisée", async () => {
    mock.method(SupportRequest, "countDocuments", async () => 0);
    mock.method(User, "findById", () => lean({ role: "family" }));
    mock.method(User, "find", () => lean([{ _id: ADMIN }]));
    mock.method(SupportRequest, "create", async (doc) => ({ _id: "64b0000000000000000000c7", createdAt: new Date(), status: "open", ...doc }));
    mock.method(Notification, "insertMany", async () => { throw new Error("db down"); });
    let done;
    const logged = new Promise((r) => { done = r; });
    mock.method(console, "error", (...a) => done(a));
    const res = await request(app).post("/api/support").set("Authorization", auth(FAMILY)).send({ topic: "account", message: "Je ne reçois pas le code SMS" });
    assert.equal(res.status, 201);
    const args = await logged;
    assert.match(String(args[0]), /notification/);
  });

  test("fins de ligne \\r\\n normalisées dans le message", async () => {
    mock.method(SupportRequest, "countDocuments", async () => 0);
    mock.method(User, "findById", () => lean({ role: "family" }));
    mock.method(User, "find", () => lean([]));
    const created = [];
    mock.method(SupportRequest, "create", async (doc) => { created.push(doc); return { _id: "64b0000000000000000000c6", createdAt: new Date(), status: "open", ...doc }; });
    const res = await request(app).post("/api/support").set("Authorization", auth(FAMILY)).send({ topic: "other", message: "Ligne un\r\nLigne deux\r\n\r\n\r\n\r\nLigne trois\rFin" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(created[0].message, "Ligne un\nLigne deux\n\nLigne trois\nFin");
  });

  test("plus de 5 demandes par heure : refusé", async () => {
    mock.method(SupportRequest, "countDocuments", async () => 5);
    const create = mock.method(SupportRequest, "create", async (d) => d);
    const res = await request(app).post("/api/support").set("Authorization", auth(FAMILY)).send({ topic: "other", message: "Encore une question pour vous" });
    assert.equal(res.status, 429);
    assert.match(res.body.message, /plusieurs demandes/);
    assert.equal(create.mock.callCount(), 0);
  });

  test("requêtes simultanées au-delà de 5 par heure : jamais plus de 5 demandes enregistrées", async () => {
    // Base simulée : chaque requête passe le premier comptage avant que les autres n'écrivent.
    const store = [];
    let seq = 0;
    let gate;
    const allCounted = new Promise((r) => { gate = r; });
    let firstCounts = 0;
    mock.method(SupportRequest, "countDocuments", async () => {
      if (firstCounts < 8) {
        firstCounts += 1;
        if (firstCounts === 8) gate();
        await allCounted;
        return 0;
      }
      return store.length;
    });
    mock.method(User, "findById", () => lean({ role: "family" }));
    mock.method(User, "find", () => lean([]));
    mock.method(SupportRequest, "create", async (doc) => {
      const d = { _id: `64b00000000000000000${String(++seq).padStart(4, "0")}`, createdAt: new Date(), status: "open", ...doc };
      store.push(d);
      await new Promise((r) => setImmediate(r));
      return d;
    });
    mock.method(SupportRequest, "deleteOne", async ({ _id }) => {
      const i = store.findIndex((d) => d._id === _id);
      if (i >= 0) store.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => request(app).post("/api/support")
      .set("Authorization", auth(FAMILY)).send({ topic: "other", message: `Question numéro ${i + 1} pour l'équipe` })));
    const statuses = results.map((r) => r.status);
    assert.ok(store.length <= 5, `${store.length} demandes enregistrées`);
    assert.ok(store.length >= 1, "au moins une demande doit passer");
    assert.ok(statuses.filter((s) => s === 429).length >= 3, statuses.join(","));
    assert.equal(statuses.filter((s) => s === 201).length, store.length);
    assert.ok(statuses.every((s) => s === 201 || s === 429), statuses.join(","));
    for (const r of results.filter((x) => x.status === 429)) assert.match(r.body.message, /plusieurs demandes/);
  });

  test("limite par adresse IP : 30 envois valides par quart d'heure, puis 429", async () => {
    mock.method(SupportRequest, "countDocuments", async () => 0);
    mock.method(User, "findById", () => lean({ role: "family" }));
    mock.method(User, "find", () => lean([]));
    mock.method(SupportRequest, "create", async (doc) => ({ _id: "64b0000000000000000000c5", createdAt: new Date(), status: "open", ...doc }));
    // Les envois anonymes ou invalides ne consomment pas le quota de l'IP.
    for (let i = 0; i < 40; i += 1) {
      assert.equal((await request(app).post("/api/support").send({ topic: "other", message: "Une question valide ici" })).status, 401);
      assert.equal((await request(app).post("/api/support").set("Authorization", auth(FAMILY)).send({ topic: "x" })).status, 400);
    }
    for (let i = 0; i < 30; i += 1) {
      const ok = await request(app).post("/api/support").set("Authorization", auth(FAMILY)).send({ topic: "other", message: "Une question valide ici" });
      assert.equal(ok.status, 201, `envoi ${i + 1}`);
    }
    const res = await request(app).post("/api/support").set("Authorization", auth(FAMILY)).send({ topic: "other", message: "Une question valide ici" });
    assert.equal(res.status, 429);
    assert.match(res.body.message, /connexion/);
    assert.ok(res.headers["retry-after"]);
  });

  test("réponse de l'équipe : coordonnées refusées (même déguisées), sauf celles d'ISD", async (t) => {
    t.after(() => { delete process.env.WHATSAPP_ISD; });
    process.env.WHATSAPP_ISD = "2250709102524";
    mock.method(User, "findById", () => lean({ isAdmin: true }));
    const fou = mock.method(SupportRequest, "findOneAndUpdate", () => chain({ _id: "64b0000000000000000000c1", user: { _id: FAMILY }, topic: "other", status: "answered", reply: { text: "x", at: new Date() } }, {}));
    mock.method(Notification, "create", async (n) => n);
    mock.method(AdminLog, "create", async (l) => l);
    const url = "/api/admin/support/64b0000000000000000000c1/reply";
    for (const text of ["Son numéro : O5 44 33 22 11", "écrivez-lui : awa (at) gmail (dot) com", "elle est sur f a c e b o o k", "zéro cinq 44 trente-trois 22 onze"]) {
      const res = await request(app).post(url).set("Authorization", auth(ADMIN)).send({ text });
      assert.equal(res.status, 400, text);
      assert.match(res.body.message, /coordonnées/);
    }
    assert.equal(fou.mock.callCount(), 0);
    const ok = await request(app).post(url).set("Authorization", auth(ADMIN)).send({ text: "Écrivez-nous sur notre WhatsApp : +225 07 09 10 25 24" });
    assert.equal(ok.status, 200);
  });

  test("réponse de l'équipe : mise à jour atomique, notification, journal sans le texte", async () => {
    mock.method(User, "findById", () => lean({ isAdmin: true }));
    const updated = { _id: "64b0000000000000000000c1", user: { _id: FAMILY, firstName: "Awa" }, topic: "payment", status: "answered", reply: { text: "Votre paiement est validé, merci !", by: { _id: ADMIN }, at: new Date() } };
    const calls = [];
    const fou = mock.method(SupportRequest, "findOneAndUpdate", (filter, update, opts) => { calls.push({ filter, update, opts }); return chain(updated, {}); });
    const notes = [];
    mock.method(Notification, "create", async (n) => { notes.push(n); return n; });
    const logs = [];
    mock.method(AdminLog, "create", async (l) => { logs.push(l); return l; });
    const url = `/api/admin/support/${updated._id}/reply`;
    assert.equal((await request(app).post(url).set("Authorization", auth(ADMIN)).send({ text: "" })).status, 400);
    assert.equal(fou.mock.callCount(), 0);
    const ok = await request(app).post(url).set("Authorization", auth(ADMIN)).send({ text: "Votre paiement est validé, merci !" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const [{ filter, update, opts }] = calls;
    assert.equal(filter._id, updated._id);
    assert.equal(filter.status, "open");
    assert.deepEqual(filter.user, { $ne: ADMIN });
    assert.equal(update.$set.status, "answered");
    assert.equal(update.$set.reply.text, "Votre paiement est validé, merci !");
    assert.equal(String(update.$set.reply.by), ADMIN);
    assert.equal(opts.new, true);
    assert.equal(ok.body.request.topicLabel, "Paiement");
    assert.equal(String(notes[0].userId), FAMILY);
    assert.equal(notes[0].metadata.support, updated._id);
    assert.equal(logs[0].action, "support_replied");
    assert.equal(logs[0].details.userId, FAMILY);
    assert.equal(logs[0].details.textLength, "Votre paiement est validé, merci !".length);
    assert.ok(!JSON.stringify(logs[0]).includes("validé"));
  });

  test("réponse : sa propre demande → 403, déjà répondue → 409, rien de notifié ni journalisé", async () => {
    mock.method(User, "findById", () => lean({ isAdmin: true }));
    mock.method(SupportRequest, "findOneAndUpdate", () => chain(null, {}));
    let existing = { _id: "64b0000000000000000000c1", user: ADMIN, status: "open" };
    mock.method(SupportRequest, "findById", () => chain(existing, {}));
    const notes = mock.method(Notification, "create", async (n) => n);
    const logs = mock.method(AdminLog, "create", async (l) => l);
    const url = "/api/admin/support/64b0000000000000000000c1/reply";
    const own = await request(app).post(url).set("Authorization", auth(ADMIN)).send({ text: "Je me réponds" });
    assert.equal(own.status, 403);
    assert.match(own.body.message, /propre demande/);
    existing = { _id: "64b0000000000000000000c1", user: FAMILY, status: "answered" };
    const twice = await request(app).post(url).set("Authorization", auth(ADMIN)).send({ text: "Deuxième réponse" });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.message, "Cette demande a déjà reçu une réponse.");
    assert.equal(notes.mock.callCount(), 0);
    assert.equal(logs.mock.callCount(), 0);
  });

  test("réponse : \\r\\n normalisés, lignes vides multiples réduites", async () => {
    mock.method(User, "findById", () => lean({ isAdmin: true }));
    let text;
    mock.method(SupportRequest, "findOneAndUpdate", (f, u) => { text = u.$set.reply.text; return chain({ _id: "64b0000000000000000000c1", user: FAMILY, topic: "other", status: "answered", reply: u.$set.reply }, {}); });
    mock.method(Notification, "create", async (n) => n);
    mock.method(AdminLog, "create", async (l) => l);
    const res = await request(app).post("/api/admin/support/64b0000000000000000000c1/reply").set("Authorization", auth(ADMIN))
      .send({ text: "Bonjour,\r\n\r\n\r\n\r\nC'est réglé.\r\nBonne journée" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(text, "Bonjour,\n\nC'est réglé.\nBonne journée");
  });
});
