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
const SESSION_ID = "64b0000000000000000000e1";
const OTHER_PROVIDER_ID = "64b0000000000000000000c2";
const S = `/api/chat/sessions/${SESSION_ID}`;
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
  _id: SESSION_ID, offerId: OFFER_ID, familyId: FAMILY_ID, providerId: PROVIDER_ID, status: "active",
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
  mock.method(ChatSession, "findById", async () => session);
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
  test("déjoue les contournements : Unicode, invisibles, homoglyphes, épellation, leet, mélanges", () => {
    for (const t of ["07/09/10/25/24", "(07) 09 10 25 24", "07,09,10,25,24", "07_09_10_25_24", "０７０９１０２５２４", "٠٧٠٩١٠٢٥٢٤",
      "0\u200b7\u200b09102524", "O7 O9 1O 25 24", "zéro sept 09 dix 25 vingt-quatre", "07/09/2010 25 24", "jean (at) gmail (dot) com",
      "w h a t s a p p", "what’s app", "whats-app", "wh4tsapp", "faceb00k", "f.a.c.e.b.o.o.k", "g m a i l", "fасеbооk", "ｗｈａｔｓａｐｐ",
      "t.me/jean", "wa.me/2250709", "jean.ci"]) {
      assert.ok(containsChatContact(t), t);
    }
  });
  test("coordonnées d'ISD autorisées seulement si demandé (réponses de l'équipe)", () => {
    const isd = { allowPhones: ["2250709102524"], allowEmails: ["contact@isd.ci"], allowIsdWhatsapp: true };
    assert.equal(containsChatContact("Écrivez-nous sur notre WhatsApp : +225 07 09 10 25 24", isd), false);
    assert.equal(containsChatContact("ou par email contact@isd.ci", isd), false);
    assert.ok(containsChatContact("Écrivez-nous sur notre WhatsApp : +225 07 09 10 25 24"));
    for (const t of ["Son numéro : 05 44 33 22 11", "Voici son whatsapp", "écrivez à awa@gmail.com"]) assert.ok(containsChatContact(t, isd), t);
  });
  test("laisse passer dates, prix, âges et horaires", () => {
    for (const t of ["Je peux commencer le 01/12/2026 à 7h30", "60 000 FCFA par mois, c’est bien", "Mes enfants ont 3 et 6 ans",
      "On se voit à 8h, puis 12h30 pour le déjeuner", "J’habite à Cocody, près du lycée", "Deux enfants, un de trois ans",
      "J’habite à Cocody. Me voici", "60 000, 70 000 ou 80 000 FCFA selon les heures", "Le 12/01/2027, de 8:30 à 12:30, puis 14:00",
      "Elle a 2 filles de 5 et 9 ans, et un garçon de 11 ans", "Facture ISD-K7P2QX réglée"]) {
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
    assert.equal((await as("get", S, OUTSIDER)).status, 404);
    assert.equal((await as("post", `${S}/messages`, OUTSIDER, { text: "Bonjour" })).status, 404);
    assert.equal(created.length, 0);
  });

  test("un participant lit seulement les messages qui lui sont visibles, sans contenu original", async () => {
    setup(fakeSession());
    let filter;
    mock.method(ChatMessage, "find", (f) => { filter = f; return q([{ _id: "m1", offerId: OFFER_ID, senderRole: "system", message: "Bienvenue", originalEncrypted: "secret", familyId: FAMILY_ID }]); });
    mock.method(User, "findById", () => q({ firstName: "Aya", lastName: "Kouadio" }));
    mock.method(Offer, "findById", () => q({ description: "Garde" }));
    const res = await as("get", S, NANNY);
    assert.equal(res.status, 200);
    assert.equal(res.body.role, "provider");
    assert.deepEqual(filter.$or.at(-1), { visibleTo: "provider" });
    // Messages de CETTE discussion seulement : (offre, prestataire)
    assert.equal(String(filter.providerId), PROVIDER_ID);
    assert.equal(res.body.session.sessionId, SESSION_ID);
    assert.equal(res.body.messages[0].originalEncrypted, undefined);
    assert.equal(res.body.messages[0].familyId, undefined);
  });

  test("offre conclue avant la Phase 4 : le chat est ouvert à la première visite", async () => {
    mock.method(ChatSession, "findOne", async () => null);
    const create = mock.method(ChatSession, "create", async (d) => fakeSession(d));
    const welcome = mock.method(ChatMessage, "create", async (d) => d);
    mock.method(Offer, "findById", () => q({ _id: OFFER_ID, family: FAMILY_ID, acceptedProvider: PROVIDER_ID, applications: [{ provider: PROVIDER_ID, status: "accepted" }] }));
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
    assert.equal((await as("post", `${S}/messages`, FAMILY, { text: "   " })).status, 400);
    assert.equal((await as("post", `${S}/messages`, FAMILY, { text: "a".repeat(1001) })).status, 400);
  });

  test("message normal : enregistré, destinataire notifié une seule fois", async () => {
    const session = fakeSession();
    const { created, notifs } = setup(session);
    const res = await as("post", `${S}/messages`, FAMILY, { text: "Bonjour Aya, vous pouvez commencer à 7h30 ?" });
    assert.equal(res.status, 201);
    assert.equal(created[0].senderRole, "family");
    assert.equal(notifs.mock.callCount(), 1);
    assert.equal(String(notifs.mock.calls[0].arguments[0].userId), PROVIDER_ID);
    mock.method(Notification, "findOne", async () => ({ _id: "déjà" }));
    await as("post", `${S}/messages`, FAMILY, { text: "Et le samedi ?" });
    assert.equal(notifs.mock.callCount(), 1);
  });

  test("coordonnées : message bloqué et chiffré, visible du seul expéditeur, avertissement", async () => {
    const session = fakeSession();
    const { created } = setup(session);
    const res = await as("post", `${S}/messages`, NANNY, { text: "Appelle-moi au 07 09 10 25 24" });
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
    const res = await as("post", `${S}/messages`, NANNY, { text: "mon whatsapp" });
    assert.equal(res.body.closed, true);
    assert.equal(session.status, "closed");
    assert.equal(session.closedReason, "contact_sharing");
    assert.equal(created.at(-1).visibleTo, undefined);
    assert.equal(String(notifs.mock.calls[0].arguments[0].userId), FAMILY_ID);
  });

  test("chat fermé : plus aucun envoi (409)", async () => {
    const { created } = setup(fakeSession({ status: "closed" }));
    assert.equal((await as("post", `${S}/messages`, FAMILY, { text: "Bonjour" })).status, 409);
    assert.equal(created.length, 0);
  });

  test("lecture : date de lecture enregistrée et notifications du chat marquées lues", async () => {
    const session = fakeSession();
    setup(session);
    const upd = mock.method(Notification, "updateMany", async () => ({}));
    const res = await as("post", `${S}/read`, FAMILY);
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
      assert.equal((await as("post", `${S}/start-date`, FAMILY, { date })).status, 400, date);
    }
  });

  test("proposer, puis seule l'autre partie peut accepter", async () => {
    const session = fakeSession();
    const { created } = setup(session);
    const upd = mock.method(ChatMessage, "findByIdAndUpdate", async () => null);
    const date = isoDay(7);
    const res = await as("post", `${S}/start-date`, FAMILY, { date });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(session.startDateProposal.by, "family");
    assert.equal(created[0].type, "start_date");
    assert.equal((await as("post", `${S}/start-date/respond`, FAMILY, { accept: true })).status, 403);
    const ok = await as("post", `${S}/start-date/respond`, NANNY, { accept: true });
    assert.equal(ok.status, 200);
    assert.equal(session.startDate.toISOString().slice(0, 10), date);
    assert.equal(session.status, "agreement_reached");
    assert.equal(session.startDateProposal.date, null);
    assert.equal(upd.mock.calls.at(-1).arguments[1].$set["meta.status"], "accepted");
    assert.equal((await as("post", `${S}/start-date`, FAMILY, { date })).status, 409);
  });

  test("refus : la proposition est retirée, une nouvelle date peut être proposée", async () => {
    const session = fakeSession({ startDateProposal: { date: new Date(`${isoDay(5)}T00:00:00Z`), by: "provider", at: new Date(), messageId: "m9" } });
    setup(session);
    mock.method(ChatMessage, "findByIdAndUpdate", async () => null);
    const res = await as("post", `${S}/start-date/respond`, FAMILY, { accept: false });
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

describe("Discussions par prestataire : cloisonnement", () => {
  afterEach(() => mock.restoreAll());
  const OTHER = tokenFor(OTHER_PROVIDER_ID, "nanny");

  test("un autre candidat de la même offre ne peut ni lire, ni écrire, ni marquer lu, ni proposer de date (404)", async () => {
    const { created } = setup(fakeSession({ status: "discussion" }));
    const upd = mock.method(Notification, "updateMany", async () => ({}));
    assert.equal((await as("get", S, OTHER)).status, 404);
    assert.equal((await as("post", `${S}/messages`, OTHER, { text: "Bonjour" })).status, 404);
    assert.equal((await as("post", `${S}/read`, OTHER)).status, 404);
    assert.equal((await as("post", `${S}/start-date`, OTHER, { date: isoDay(7) })).status, 404);
    assert.equal(created.length, 0);
    assert.equal(upd.mock.callCount(), 0);
  });

  test("ancienne adresse par offre : le prestataire n'obtient que SA discussion", async () => {
    let filter;
    mock.method(ChatSession, "findOne", async (f) => { filter = f; return null; });
    mock.method(Offer, "findById", async () => ({ _id: OFFER_ID, family: FAMILY_ID, applications: [{ provider: PROVIDER_ID, status: "pending", stage: "applied" }] }));
    const res = await as("get", `/api/chat/${OFFER_ID}`, OTHER);
    assert.equal(res.status, 404);
    assert.equal(String(filter.providerId), OTHER_PROVIDER_ID);
  });

  test("ancienne adresse par offre : la famille choisit la discussion avec ?providerId", async () => {
    let filter;
    const session = fakeSession({ status: "discussion" });
    mock.method(ChatSession, "findOne", async (f) => { filter = f; return session; });
    mock.method(ChatMessage, "find", () => q([]));
    mock.method(User, "findById", () => q({ firstName: "Aya" }));
    mock.method(Offer, "findById", () => q({ _id: OFFER_ID, applications: [] }));
    const res = await as("get", `/api/chat/${OFFER_ID}?providerId=${PROVIDER_ID}`, FAMILY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(String(filter.providerId), PROVIDER_ID);
    assert.equal(res.body.session.status, "discussion");
  });

  test("le salaire convenu avec un autre prestataire n'apparaît jamais dans ma discussion", async () => {
    setup(fakeSession({ status: "closed", closedReason: "other_chosen" }));
    mock.method(ChatMessage, "find", () => q([]));
    mock.method(User, "findById", () => q({ firstName: "Aya" }));
    mock.method(Offer, "findById", () => q({
      _id: OFFER_ID, status: "closed", price: 50000, agreedPrice: 62000, acceptedProvider: OTHER_PROVIDER_ID,
      applications: [
        { provider: PROVIDER_ID, status: "rejected", stage: "rejected", history: [{ by: "provider", amount: 70000 }], proposedPrice: 70000 },
        { provider: OTHER_PROVIDER_ID, status: "accepted", stage: "accepted", history: [{ by: "provider", amount: 62000 }], proposedPrice: 62000 },
      ],
    }));
    const res = await as("get", S, NANNY);
    assert.equal(res.status, 200);
    assert.equal(res.body.offer.agreedPrice, null);
    assert.equal(res.body.offer.applications, undefined);
    assert.equal(res.body.application.proposedPrice, 70000); // seulement mon propre historique
    assert.ok(!JSON.stringify(res.body).includes("62000"));
    assert.ok(!JSON.stringify(res.body).includes(OTHER_PROVIDER_ID));
  });

  test("liste : le salaire d'un concurrent n'apparaît pas non plus", async () => {
    mock.method(ChatSession, "find", () => q([{ ...fakeSession({ status: "closed" }), save: undefined }]));
    mock.method(User, "findById", () => q({ firstName: "Marie" }));
    mock.method(Offer, "findById", () => q({ _id: OFFER_ID, agreedPrice: 62000, acceptedProvider: OTHER_PROVIDER_ID, applications: [{ provider: PROVIDER_ID, status: "rejected", stage: "rejected" }] }));
    mock.method(ChatMessage, "findOne", () => q(null));
    mock.method(ChatMessage, "countDocuments", async () => 0);
    const res = await as("get", "/api/chat", NANNY);
    assert.equal(res.status, 200);
    assert.equal(res.body[0].offer.agreedPrice, null);
    assert.equal(res.body[0].application.stage, "rejected");
    assert.equal(res.body[0].sessionId, SESSION_ID);
  });

  test("étape discussion : le filtre de coordonnées s'applique déjà", async () => {
    const session = fakeSession({ status: "discussion" });
    const { created } = setup(session);
    const res = await as("post", `${S}/messages`, FAMILY, { text: "Mon numéro : 07 09 10 25 24" });
    assert.equal(res.status, 200);
    assert.equal(res.body.blocked, true);
    assert.equal(created[0].type, "blocked");
    assert.equal(created[0].visibleTo, "family");
    assert.equal(String(created[0].sessionId), SESSION_ID);
  });

  test("étape discussion : pas encore de date de début (409)", async () => {
    const { created } = setup(fakeSession({ status: "discussion" }));
    const res = await as("post", `${S}/start-date`, FAMILY, { date: isoDay(7) });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /salaire accepté/);
    assert.equal(created.length, 0);
  });

  test("lecture : seules les notifications de cette discussion sont marquées lues", async () => {
    setup(fakeSession());
    const upd = mock.method(Notification, "updateMany", async () => ({}));
    await as("post", `${S}/read`, FAMILY);
    const f = upd.mock.calls[0].arguments[0];
    assert.deepEqual(f.$or[0], { "metadata.sessionId": SESSION_ID });
  });

  test("identifiant de discussion invalide (400)", async () => {
    assert.equal((await as("get", "/api/chat/sessions/abc", FAMILY)).status, 400);
  });
});

describe("Socket : salons par discussion", () => {
  afterEach(() => mock.restoreAll());
  const initSocket = require("../socket/socketManager");

  // Faux serveur Socket.io : on récupère le middleware et le gestionnaire de connexion.
  const fakeIo = () => {
    const io = { mw: null, onConn: null, emitted: [] };
    io.use = (fn) => { io.mw = fn; };
    io.on = (ev, fn) => { if (ev === "connection") io.onConn = fn; };
    io.in = () => ({ fetchSockets: async () => [] });
    io.to = (r) => ({ emit: (ev, p) => io.emitted.push({ r, ev, p }) });
    return io;
  };
  const connect = async (io, id, role) => {
    const handlers = {};
    const socket = {
      handshake: { auth: { token: tokenFor(id, role) } }, data: {}, id: `s-${id}`, rooms: [],
      join: (r) => socket.rooms.push(r), leave: (r) => { socket.rooms = socket.rooms.filter((x) => x !== r); },
      on: (ev, fn) => { handlers[ev] = fn; }, to: () => ({ emit() {} }),
    };
    await new Promise((resolve, reject) => io.mw(socket, (err) => (err ? reject(err) : resolve())));
    io.onConn(socket);
    const join = (payload) => new Promise((resolve) => handlers["chat:join"](payload, resolve));
    return { socket, join, handlers };
  };
  const lean = (doc) => ({ select() { return this; }, lean: async () => doc });

  test("rejoindre sa discussion : salon chat:<sessionId>:<rôle>", async () => {
    mock.method(ChatSession, "findById", () => lean({ _id: SESSION_ID, offerId: OFFER_ID, familyId: FAMILY_ID, providerId: PROVIDER_ID }));
    const io = fakeIo();
    initSocket(io);
    const { socket, join } = await connect(io, PROVIDER_ID, "nanny");
    const r = await join({ sessionId: SESSION_ID });
    assert.equal(r.ok, true);
    assert.equal(r.sessionId, SESSION_ID);
    assert.ok(socket.rooms.includes(`chat:${SESSION_ID}:provider`));
  });

  test("un autre candidat ne peut pas rejoindre la discussion d'un concurrent", async () => {
    mock.method(ChatSession, "findById", () => lean({ _id: SESSION_ID, offerId: OFFER_ID, familyId: FAMILY_ID, providerId: PROVIDER_ID }));
    const io = fakeIo();
    initSocket(io);
    const { socket, join } = await connect(io, OTHER_PROVIDER_ID, "nanny");
    const r = await join(SESSION_ID);
    assert.equal(r.ok, false);
    assert.ok(!socket.rooms.some((x) => x.startsWith("chat:")));
  });

  test("ancienne app (identifiant d'offre) : le prestataire rejoint sa propre discussion", async () => {
    mock.method(ChatSession, "findById", () => lean(null));
    let filter;
    mock.method(ChatSession, "findOne", (f) => { filter = f; return lean({ _id: SESSION_ID, offerId: OFFER_ID, familyId: FAMILY_ID, providerId: PROVIDER_ID }); });
    const io = fakeIo();
    initSocket(io);
    const { join } = await connect(io, PROVIDER_ID, "nanny");
    const r = await join(OFFER_ID);
    assert.equal(r.ok, true);
    assert.equal(filter.providerId, PROVIDER_ID);
  });

  test("diffusion : messages et candidature vers les seuls salons de la discussion", () => {
    const chat = require("../services/chat");
    const io = fakeIo();
    const session = fakeSession();
    chat.emitMessage(io, { _id: "m1", sessionId: SESSION_ID, offerId: OFFER_ID, familyId: FAMILY_ID, providerId: PROVIDER_ID, message: "x", visibleTo: "family", originalEncrypted: "secret" }, session);
    assert.deepEqual(io.emitted.map((e) => e.r), [`chat:${SESSION_ID}:family`, `user:${FAMILY_ID}`]);
    assert.equal(io.emitted[0].p.originalEncrypted, undefined);
    assert.equal(io.emitted[1].p.sessionId, SESSION_ID);
    io.emitted.length = 0;
    chat.emitApplication(io, session, { stage: "salary" });
    assert.deepEqual(io.emitted.filter((e) => e.ev === "chat:application").map((e) => e.r), [`chat:${SESSION_ID}:family`, `chat:${SESSION_ID}:provider`]);
  });
});

describe("Revue de sécurité : filtre de coordonnées renforcé", () => {
  const { messageDigits, phoneAcrossMessages, hasContactIntent } = require("../validators/contact");

  test("bloque les contournements : lettres, mots, emojis, longs séparateurs, keycaps, mots-nombres, phonétique", () => {
    for (const t of ["07 et 09 et 10 et 25 et 24", "07a09b10c25d24", "07💛09💛10💛25💛24", "07 ☎ 09 ☎ 10 ☎ 25 ☎ 24", "07😀09😀10😀25😀24",
      "07    09    10    25    24", "0 7 - - - - 0 9 - - - - 1 0 - - - - 2 5 2 4", "0⃣7⃣0⃣9⃣1⃣0⃣2⃣5⃣2⃣4⃣", "zero sept zero neuf dix",
      "soixante-dix-sept quatre-vingt-neuf dix vingt-cinq vingt-quatre", "seven zero nine one zero two five two four", "zéro sèt zéro nèf di vin-senk",
      "appelle moi au double zéro sept, neuf, dix, vingt cinq, vingt quatre", "fixe : 27 22 44 55 66", "jean @ orange . ci"]) {
      assert.ok(containsChatContact(t), t);
    }
  });

  test("bloque messageries et réseaux (abréviations, fautes, Facebook déguisé)", () => {
    for (const t of ["wassap", "wasap", "watsp", "wtsp", "wsp", "wpp", "whatsa", "w.a", "viber", "skype", "discord", "botim", "wechat", "on se parle sur tg",
      "youtube", "fesse bouc", "face bouk", "fbk", "mon profil fcbk Jean Kouassi", "cherche moi sur le livre des visages"]) {
      assert.ok(containsChatContact(t), t);
    }
  });

  test("aucun faux positif sur les échanges normaux", () => {
    for (const t of ["60 000 FCFA par mois", "5 jours sur 7", "de 7h à 18h", "3 enfants de 4, 6 et 9 ans", "Le 01/05/2027 de 7h30 à 12h",
      "50 000 à 75 000 ou 80 000", "entre 50 000 et 60 000 FCFA", "je paie par Mobile Money ou Wave", "Wave ou Orange Money c'est bon",
      "Lundi 7h-12h, mardi 14h-18h, mercredi 7h-18h", "du 05/01 au 07/02, 25 jours", "2 500 FCFA de l'heure, 3 séances par semaine",
      "Je propose 75000 par mois", "rendez-vous le 07/09 à 10h", "il est né en 2019, elle en 2021", "tous les jours de 6h30 à 19h sauf dimanche",
      "On dit 70 000 ? sinon 65 000", "j'ai vingt-cinq ans et deux enfants", "zéro problème", "ça fait deux ans que je garde des enfants de un à six ans",
      "mon numéro orange money commence par 07", "Envoie-moi ton OM", "né le 12/05/1995"]) {
      assert.equal(containsChatContact(t), false, t);
    }
  });

  test("numéro dicté en plusieurs messages : reconstitué ; montants et horaires successifs : jamais", () => {
    const seq = (msgs) => { const f = []; return msgs.some((m) => { f.push(messageDigits(m)); return phoneAcrossMessages(f.slice(-5)); }); };
    assert.equal(seq(["0709", "1025 24"]), true);
    assert.equal(seq(["07 09", "10", "25 24"]), true);
    assert.equal(seq(["zero sept zero neuf", "dix vingt-cinq vingt-quatre"]), true);
    assert.equal(seq(["Je propose 50 000", "70 000 ?", "ok 75 000"]), false);
    assert.equal(seq(["J'ai 2 enfants", "de 4 et 7 ans", "de 7h à 18h", "5 jours sur 7", "le 12/05"]), false);
  });

  test("intention seule : détectée (rappel), jamais bloquée", () => {
    for (const t of ["mon numéro orange money", "appelle-moi demain", "bipe moi ce soir"]) {
      assert.ok(hasContactIntent(t), t);
      assert.equal(containsChatContact(t), false, t);
    }
    assert.equal(hasContactIntent("Bonjour, à demain"), false);
  });
});

describe("Revue de sécurité : chat", () => {
  afterEach(() => mock.restoreAll());

  test("numéro coupé en deux messages : le 2e est bloqué comme un message ordinaire", async () => {
    const session = fakeSession({ status: "discussion" });
    const { created } = setup(session);
    mock.method(User, "findByIdAndUpdate", () => q({ contactStrikes: 1 }));
    const r1 = await as("post", `${S}/messages`, NANNY, { text: "0709" });
    assert.equal(r1.status, 201);
    const r2 = await as("post", `${S}/messages`, NANNY, { text: "1025 24" });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.blocked, true);
    assert.equal(r2.body.warnings, 1);
    assert.equal(created.at(-2).type, "blocked");
    assert.deepEqual(session.contactMemory.provider, []); // mémoire vidée après blocage
  });

  test("la mémoire est propre à chaque partie", async () => {
    const session = fakeSession({ status: "discussion" });
    setup(session);
    await as("post", `${S}/messages`, NANNY, { text: "0709" });
    const r = await as("post", `${S}/messages`, FAMILY, { text: "1025 24" });
    assert.equal(r.status, 201);
  });

  test("intention seule : rappel discret à l'expéditeur, une seule fois, sans avertissement", async () => {
    const session = fakeSession();
    setup(session);
    const r1 = await as("post", `${S}/messages`, FAMILY, { text: "Donne-moi ton numéro stp" });
    assert.equal(r1.status, 201);
    assert.equal(r1.body.reminder.visibleTo, "family");
    assert.equal(r1.body.reminder.meta.kind, "contact_reminder");
    assert.equal(session.warnings.family, 0);
    const r2 = await as("post", `${S}/messages`, FAMILY, { text: "appelle-moi ce soir" });
    assert.equal(r2.body.reminder, null);
  });

  test("blocage : tentative comptée sur le compte", async () => {
    setup(fakeSession());
    const strikes = mock.method(User, "findByIdAndUpdate", () => q({ contactStrikes: 2 }));
    await as("post", `${S}/messages`, FAMILY, { text: "mon whatsapp" });
    assert.equal(String(strikes.mock.calls[0].arguments[0]), FAMILY_ID);
    assert.deepEqual(strikes.mock.calls[0].arguments[1], { $inc: { contactStrikes: 1 } });
  });

  test("3e infraction : la candidature est refusée (contact_sharing) et ne compte plus dans les discussions", async () => {
    const session = fakeSession({ status: "discussion", warnings: { family: 0, provider: 2 } });
    setup(session);
    const offer = { _id: OFFER_ID, family: FAMILY_ID, status: "open", applications: [{ provider: PROVIDER_ID, status: "pending", stage: "salary" }], saves: 0, async save() { this.saves += 1; } };
    mock.method(Offer, "findById", async () => offer);
    const res = await as("post", `${S}/messages`, NANNY, { text: "mon whatsapp" });
    assert.equal(res.body.closed, true);
    assert.equal(offer.applications[0].stage, "rejected");
    assert.equal(offer.applications[0].closedReason, "contact_sharing");
    assert.equal(require("../services/applications").activeCount(offer), 0);
    assert.equal(offer.saves, 1);
  });

  test("noms : initiale avant paiement, nom complet après", async () => {
    setup(fakeSession());
    mock.method(ChatMessage, "find", () => q([]));
    mock.method(User, "findById", () => q({ firstName: "Aya", lastName: "Kouassi" }));
    mock.method(Offer, "findById", () => q({ _id: OFFER_ID, applications: [] }));
    const before = await as("get", S, FAMILY);
    assert.equal(before.body.other.lastName, "K.");
    assert.equal(before.body.other.firstName, "Aya");
    mock.restoreAll();
    setup(fakeSession({ isPaid: true }));
    mock.method(ChatMessage, "find", () => q([]));
    mock.method(User, "findById", () => q({ firstName: "Aya", lastName: "Kouassi" }));
    mock.method(Offer, "findById", () => q({ _id: OFFER_ID, applications: [] }));
    assert.equal((await as("get", S, FAMILY)).body.other.lastName, "Kouassi");
  });

  test("liste des conversations : initiale avant paiement", async () => {
    mock.method(ChatSession, "find", () => q([{ ...fakeSession(), save: undefined }]));
    mock.method(User, "findById", () => q({ firstName: "Marie", lastName: "Yao" }));
    mock.method(Offer, "findById", () => q({ _id: OFFER_ID, applications: [] }));
    mock.method(ChatMessage, "findOne", () => q(null));
    mock.method(ChatMessage, "countDocuments", async () => 0);
    const res = await as("get", "/api/chat", NANNY);
    assert.equal(res.body[0].other.lastName, "Y.");
  });

  test("limite : 30 messages par minute et par compte (429)", async () => {
    const { chatLimiter } = require("../routes/chatRoutes");
    chatLimiter.reset();
    setup(fakeSession());
    let last;
    for (let i = 0; i < 31; i += 1) last = await as("post", `${S}/messages`, FAMILY, { text: `Bonjour ${i % 2 ? "Aya" : "à vous"}` });
    assert.equal(last.status, 429);
    assert.match(last.body.message, /patientez une minute/);
    chatLimiter.reset();
  });
});

describe("Signal de modération (tentatives cumulées)", () => {
  afterEach(() => mock.restoreAll());
  const Report = require("../models/Report");
  const { recordContactStrike } = require("../services/moderation");

  test("au 5e refus : signalement pour l'équipe ISD, sans suspension", async () => {
    const reports = mock.method(Report, "create", async (d) => d);
    mock.method(User, "findByIdAndUpdate", () => q({ contactStrikes: 4 }));
    assert.equal(await recordContactStrike(FAMILY_ID, "chat"), 4);
    assert.equal(reports.mock.callCount(), 0);
    mock.method(User, "findByIdAndUpdate", () => q({ contactStrikes: 5 }));
    assert.equal(await recordContactStrike(FAMILY_ID, "profile"), 5);
    const r = reports.mock.calls[0].arguments[0];
    assert.equal(r.kind, "contact_strikes");
    assert.equal(r.against, FAMILY_ID);
    assert.equal(r.byRole, "system");
    assert.equal(r.strikes, 5);
  });

  test("signalement automatique valide sans offre ni récapitulatif", () => {
    const Report2 = require("../models/Report");
    const doc = new Report2({ kind: "contact_strikes", against: FAMILY_ID, byRole: "system", reason: "contact_strikes" });
    assert.equal(doc.validateSync(), undefined);
    const mission = new Report2({ byRole: "family", reason: "behaviour" });
    assert.ok(mission.validateSync().errors.offerId);
  });
});
