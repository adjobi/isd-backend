process.env.CHAT_ENCRYPTION_KEY = "a".repeat(64);
const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const Offer = require("../models/Offer");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { ChatSession, ChatMessage } = require("../models/Chat");
const { containsChatContact } = require("../validators/contact");
const { encrypt, decrypt } = require("../utils/crypto");
const { tokenFor, buildApp } = require("./helpers");

const app = buildApp();
const FAMILY_ID = "64b0000000000000000000a1";
const PROVIDER_ID = "64b0000000000000000000c1";
const OUTSIDER_ID = "64b0000000000000000000d1";
const OFFER_ID = "64b0000000000000000000b1";
const FAMILY = tokenFor(FAMILY_ID, "family");
const NANNY = tokenFor(PROVIDER_ID, "nanny");
const OUTSIDER = tokenFor(OUTSIDER_ID, "nanny");

// Requête Mongoose factice : chaînable et « awaitable ».
const q = (doc) => {
  const o = { select: () => o, sort: () => o, limit: () => o, lean: async () => doc };
  o.then = (res, rej) => Promise.resolve(doc).then(res, rej);
  return o;
};
const fakeSession = (extra = {}) => ({
  offerId: OFFER_ID, familyId: FAMILY_ID, providerId: PROVIDER_ID, status: "active",
  warnings: { family: 0, provider: 0 }, warningCount: 0, lastReadAt: {}, startDate: null,
  startDateProposal: { date: null, by: null, at: null, messageId: null },
  saves: 0, async save() { this.saves += 1; }, ...extra,
});
const as = (method, url, token, body) => {
  const r = request(app)[method](url).set("Authorization", `Bearer ${token}`);
  return body ? r.send(body) : r;
};
// Mocks de base : session donnée, création de messages et notifications enregistrées.
const setup = (session) => {
  mock.method(ChatSession, "findOne", async () => session);
  const created = [];
  mock.method(ChatMessage, "create", async (d) => { const m = { _id: `m${created.length}`, createdAt: new Date(), ...d }; created.push(m); return m; });
  const notifs = mock.method(Notification, "create", async () => ({}));
  mock.method(Notification, "findOne", async () => null);
  return { created, notifs };
};
const isoDay = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

describe("Détection des coordonnées dans le chat", () => {
  test("bloque numéros (même déguisés), emails, liens et réseaux sociaux", () => {
    for (const t of ["07 09 10 25 24", "0709102524", "+225 07 09 10 25 24", "07-09-10-25-24", "07 . 09 . 10 . 25 . 24",
      "zéro sept zéro neuf dix vingt cinq vingt quatre", "jean arobase gmail point com", "jean@gmail.com",
      "écris-moi sur wa", "mon Facebook c’est Jean", "@jean_k", "www.jean.ci", "mon insta"]) {
      assert.ok(containsChatContact(t), t);
    }
  });
  test("laisse passer dates, prix, âges et horaires", () => {
    for (const t of ["Je peux commencer le 01/12/2026 à 7h30", "60 000 FCFA par mois, c’est bien", "Mes enfants ont 3 et 6 ans",
      "On se voit à 8h, puis 12h30 pour le déjeuner", "J’habite à Cocody, près du lycée", "Deux enfants, un de trois ans"]) {
      assert.equal(containsChatContact(t), false, t);
    }
  });
  test("chiffrement : le contenu bloqué n'est jamais stocké en clair", () => {
    const enc = encrypt("07 09 10 25 24");
    assert.ok(!enc.includes("07 09"));
    assert.equal(decrypt(enc), "07 09 10 25 24");
  });
});

describe("Accès au chat", () => {
  afterEach(() => mock.restoreAll());

  test("identifiant invalide (400)", async () => {
    assert.equal((await as("get", "/api/chat/abc", FAMILY)).status, 400);
  });

  test("un compte extérieur ne peut ni lire ni écrire (404)", async () => {
    const { created } = setup(fakeSession());
    assert.equal((await as("get", `/api/chat/${OFFER_ID}`, OUTSIDER)).status, 404);
    assert.equal((await as("post", `/api/chat/${OFFER_ID}/messages`, OUTSIDER, { text: "Bonjour" })).status, 404);
    assert.equal(created.length, 0);
  });

  test("un participant lit seulement les messages qui lui sont visibles, sans contenu original", async () => {
    setup(fakeSession());
    let filter;
    mock.method(ChatMessage, "find", (f) => { filter = f; return q([{ _id: "m1", offerId: OFFER_ID, senderRole: "system", message: "Bienvenue", originalEncrypted: "secret", familyId: FAMILY_ID }]); });
    mock.method(User, "findById", () => q({ firstName: "Aya", lastName: "Kouadio" }));
    mock.method(Offer, "findById", () => q({ description: "Garde" }));
    const res = await as("get", `/api/chat/${OFFER_ID}`, NANNY);
    assert.equal(res.status, 200);
    assert.equal(res.body.role, "provider");
    assert.deepEqual(filter.$or.at(-1), { visibleTo: "provider" });
    assert.equal(res.body.messages[0].originalEncrypted, undefined);
    assert.equal(res.body.messages[0].familyId, undefined);
  });

  test("offre conclue avant la Phase 4 : le chat est ouvert à la première visite", async () => {
    mock.method(ChatSession, "findOne", async () => null);
    const create = mock.method(ChatSession, "create", async (d) => fakeSession(d));
    const welcome = mock.method(ChatMessage, "create", async (d) => d);
    mock.method(Offer, "findById", () => q({ _id: OFFER_ID, family: FAMILY_ID, applications: [{ provider: PROVIDER_ID, status: "accepted" }] }));
    mock.method(ChatMessage, "find", () => q([]));
    mock.method(User, "findById", () => q({}));
    const res = await as("get", `/api/chat/${OFFER_ID}`, FAMILY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(create.mock.callCount(), 1);
    assert.equal(welcome.mock.calls[0].arguments[0].senderRole, "system");
  });

  test("liste : seulement mes conversations", async () => {
    let filter;
    mock.method(ChatSession, "find", (f) => { filter = f; return q([]); });
    const res = await as("get", "/api/chat", NANNY);
    assert.equal(res.status, 200);
    assert.deepEqual(filter, { $or: [{ familyId: PROVIDER_ID }, { providerId: PROVIDER_ID }] });
  });
});

describe("Messages", () => {
  afterEach(() => mock.restoreAll());

  test("message vide ou trop long (400)", async () => {
    setup(fakeSession());
    assert.equal((await as("post", `/api/chat/${OFFER_ID}/messages`, FAMILY, { text: "   " })).status, 400);
    assert.equal((await as("post", `/api/chat/${OFFER_ID}/messages`, FAMILY, { text: "a".repeat(1001) })).status, 400);
  });

  test("message normal : enregistré, destinataire notifié une seule fois", async () => {
    const session = fakeSession();
    const { created, notifs } = setup(session);
    const res = await as("post", `/api/chat/${OFFER_ID}/messages`, FAMILY, { text: "Bonjour Aya, vous pouvez commencer à 7h30 ?" });
    assert.equal(res.status, 201);
    assert.equal(created[0].senderRole, "family");
    assert.equal(notifs.mock.callCount(), 1);
    assert.equal(String(notifs.mock.calls[0].arguments[0].userId), PROVIDER_ID);
    mock.method(Notification, "findOne", async () => ({ _id: "déjà" }));
    await as("post", `/api/chat/${OFFER_ID}/messages`, FAMILY, { text: "Et le samedi ?" });
    assert.equal(notifs.mock.callCount(), 1);
  });

  test("coordonnées : message bloqué et chiffré, visible du seul expéditeur, avertissement", async () => {
    const session = fakeSession();
    const { created } = setup(session);
    const res = await as("post", `/api/chat/${OFFER_ID}/messages`, NANNY, { text: "Appelle-moi au 07 09 10 25 24" });
    assert.equal(res.status, 200);
    assert.equal(res.body.blocked, true);
    assert.equal(res.body.warnings, 1);
    const blocked = created[0];
    assert.equal(blocked.visibleTo, "provider");
    assert.ok(!blocked.message.includes("07"));
    assert.equal(decrypt(blocked.originalEncrypted), "Appelle-moi au 07 09 10 25 24");
    assert.equal(created[1].visibleTo, "provider");
    assert.ok(res.body.messages.every((m) => m.originalEncrypted === undefined));
    assert.equal(session.status, "active");
  });

  test("3e infraction de la même partie : chat fermé, l'autre partie prévenue", async () => {
    const session = fakeSession({ warnings: { family: 0, provider: 2 } });
    const { created, notifs } = setup(session);
    const res = await as("post", `/api/chat/${OFFER_ID}/messages`, NANNY, { text: "mon whatsapp" });
    assert.equal(res.body.closed, true);
    assert.equal(session.status, "closed");
    assert.equal(session.closedReason, "contact_sharing");
    assert.equal(created.at(-1).visibleTo, undefined);
    assert.equal(String(notifs.mock.calls[0].arguments[0].userId), FAMILY_ID);
  });

  test("chat fermé : plus aucun envoi (409)", async () => {
    const { created } = setup(fakeSession({ status: "closed" }));
    assert.equal((await as("post", `/api/chat/${OFFER_ID}/messages`, FAMILY, { text: "Bonjour" })).status, 409);
    assert.equal(created.length, 0);
  });

  test("lecture : date de lecture enregistrée et notifications du chat marquées lues", async () => {
    const session = fakeSession();
    setup(session);
    const upd = mock.method(Notification, "updateMany", async () => ({}));
    const res = await as("post", `/api/chat/${OFFER_ID}/read`, FAMILY);
    assert.equal(res.status, 200);
    assert.ok(session.lastReadAt.family instanceof Date);
    assert.equal(upd.mock.calls[0].arguments[0].userId, FAMILY_ID);
  });
});

describe("Date de début", () => {
  afterEach(() => mock.restoreAll());

  test("refuse une date passée, invalide ou trop lointaine (400)", async () => {
    setup(fakeSession());
    for (const date of [isoDay(-2), "2026-02-30", "demain", isoDay(400)]) {
      assert.equal((await as("post", `/api/chat/${OFFER_ID}/start-date`, FAMILY, { date })).status, 400, date);
    }
  });

  test("proposer, puis seule l'autre partie peut accepter", async () => {
    const session = fakeSession();
    const { created } = setup(session);
    const upd = mock.method(ChatMessage, "findByIdAndUpdate", async () => null);
    const date = isoDay(7);
    const res = await as("post", `/api/chat/${OFFER_ID}/start-date`, FAMILY, { date });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(session.startDateProposal.by, "family");
    assert.equal(created[0].type, "start_date");
    assert.equal((await as("post", `/api/chat/${OFFER_ID}/start-date/respond`, FAMILY, { accept: true })).status, 403);
    const ok = await as("post", `/api/chat/${OFFER_ID}/start-date/respond`, NANNY, { accept: true });
    assert.equal(ok.status, 200);
    assert.equal(session.startDate.toISOString().slice(0, 10), date);
    assert.equal(session.status, "agreement_reached");
    assert.equal(session.startDateProposal.date, null);
    assert.equal(upd.mock.calls.at(-1).arguments[1].$set["meta.status"], "accepted");
    assert.equal((await as("post", `/api/chat/${OFFER_ID}/start-date`, FAMILY, { date })).status, 409);
  });

  test("refus : la proposition est retirée, une nouvelle date peut être proposée", async () => {
    const session = fakeSession({ startDateProposal: { date: new Date(`${isoDay(5)}T00:00:00Z`), by: "provider", at: new Date(), messageId: "m9" } });
    setup(session);
    mock.method(ChatMessage, "findByIdAndUpdate", async () => null);
    const res = await as("post", `/api/chat/${OFFER_ID}/start-date/respond`, FAMILY, { accept: false });
    assert.equal(res.status, 200);
    assert.equal(session.startDate, null);
    assert.equal(session.startDateProposal.date, null);
  });
});

describe("Paiement", () => {
  test("« J'ai payé » est désactivé jusqu'à la Phase 5 (503)", async () => {
    const res = await as("post", `/api/chat/confirm-payment/${OFFER_ID}`, FAMILY);
    assert.equal(res.status, 503);
  });
});
