// Parcours offre → candidature → discussion (mission) → salaire → accord.
const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const Offer = require("../models/Offer");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { ChatSession, ChatMessage } = require("../models/Chat");
const apps = require("../services/applications");
const chat = require("../services/chat");
const { tokenFor, buildApp } = require("./helpers");

const app = buildApp();
const FAMILY_ID = "64b0000000000000000000a1";
const OTHER_FAMILY = "64b0000000000000000000a2";
const OFFER_ID = "64b0000000000000000000b1";
const P1 = "64b0000000000000000000c1";
const P2 = "64b0000000000000000000c2";
const P3 = "64b0000000000000000000c3";
const P4 = "64b0000000000000000000c4";
const FAMILY = tokenFor(FAMILY_ID, "family");
const NANNY1 = tokenFor(P1, "nanny");
const NANNY2 = tokenFor(P2, "nanny");
const TUTOR = tokenFor(P2, "tutor");

const application = (provider, extra = {}) => ({
  provider, status: "pending", stage: "applied", missionAgreed: { family: null, provider: null },
  proposedPrice: null, lastOfferBy: null, history: [], message: "", ...extra,
});
const inDiscussion = (provider, extra = {}) => application(provider, { stage: "discussion", sessionId: `s-${provider}`, ...extra });
const inSalary = (provider, history = [], extra = {}) => application(provider, {
  stage: "salary", sessionId: `s-${provider}`, missionAgreed: { family: new Date(), provider: new Date() },
  history, proposedPrice: history.length ? history.at(-1).amount : null, lastOfferBy: history.length ? history.at(-1).by : null, ...extra,
});
const fakeOffer = (extra = {}) => ({
  _id: OFFER_ID, family: FAMILY_ID, serviceType: "nanny", status: "open", price: 50000, targetProvider: null,
  applications: [], saves: 0, async save() { this.saves += 1; }, ...extra,
});

// Base simulée : offre, discussions par prestataire, messages, notifications.
const setup = (offer, { sessions = {}, pricingType = "month", familyOffers = [] } = {}) => {
  mock.method(Offer, "findById", async () => offer);
  // Discussions de la famille sur ses autres offres (plafond de 6)
  const familyQuery = mock.method(Offer, "find", () => ({ select() { return this; }, lean: async () => familyOffers }));
  const store = {};
  for (const [providerId, extra] of Object.entries(sessions)) {
    store[providerId] = { _id: `s-${providerId}`, offerId: OFFER_ID, familyId: FAMILY_ID, providerId, status: "discussion", saves: 0, async save() { this.saves += 1; }, ...extra };
  }
  mock.method(ChatSession, "findOne", async (f) => store[String(f.providerId)] || null);
  const created = mock.method(ChatSession, "create", async (d) => {
    const s = { _id: d._id || "chat", ...d, saves: 0, async save() { this.saves += 1; } };
    store[String(d.providerId)] = s;
    return s;
  });
  const messages = [];
  mock.method(ChatMessage, "create", async (d) => { const m = { _id: d._id || `m${messages.length}`, ...d }; messages.push(m); return m; });
  const cards = mock.method(ChatMessage, "findByIdAndUpdate", async () => null);
  mock.method(User, "findById", () => ({ select() { return this; }, lean: async () => ({ pricingType }) }));
  const notify = mock.method(Notification, "create", async () => ({}));
  return { notify, store, created, messages, cards, familyQuery };
};
const as = (method, url, token, body) => {
  const r = request(app)[method](url).set("Authorization", `Bearer ${token}`);
  return body ? r.send(body) : r;
};
const lean = (doc) => ({ select() { return this; }, lean: async () => doc });
const url = (p, action) => `/api/offers/${OFFER_ID}/applications/${p}/${action}`;

describe("Étapes d'une candidature (services/applications)", () => {
  test("étape, tour et compteurs", () => {
    assert.equal(apps.stageOf({ status: "pending" }), "applied");
    assert.equal(apps.stageOf({ status: "accepted", stage: "applied" }), "accepted"); // ancienne candidature acceptée
    assert.equal(apps.stageOf({ status: "rejected" }), "rejected");
    assert.equal(apps.stageOf({ status: "withdrawn", stage: "withdrawn" }), "withdrawn");
    assert.equal(apps.turnOf(inDiscussion(P1)), null);
    assert.equal(apps.turnOf(inSalary(P1)), "either");
    assert.equal(apps.turnOf(inSalary(P1, [{ by: "family", amount: 40000 }])), "provider");
    assert.deepEqual(apps.countersLeft(inSalary(P1, [{ by: "family", amount: 40000 }, { by: "provider", amount: 45000 }])), { family: 3, provider: 2 });
    assert.equal(apps.activeCount({ applications: [application(P1), inDiscussion(P2), inSalary(P3), application(P4, { status: "rejected", stage: "rejected" })] }), 2);
  });

  test("sérialisation : pas d'identifiant de carte interne, prix nul avant toute proposition", () => {
    const s = apps.serializeApplication(inDiscussion(P1, { proposedPrice: 50000, priceCardId: "x" }));
    assert.equal(s.priceCardId, undefined);
    assert.equal(s.proposedPrice, null);
    assert.equal(s.sessionId, `s-${P1}`);
    assert.deepEqual(Object.keys(s.missionAgreed), ["family", "provider"]);
  });
});

describe("Création d'offre", () => {
  afterEach(() => mock.restoreAll());

  test("refuse les coordonnées dans la description (400)", async () => {
    const create = mock.method(Offer, "create", async (d) => d);
    const res = await as("post", "/api/offers", FAMILY, { serviceType: "nanny", description: "Appelez-nous au 07 12 34 56 78 pour la garde", duration: "long", city: "Abidjan" });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.description);
    assert.equal(create.mock.callCount(), 0);
  });

  test("valide les champs obligatoires et les montants (400)", async () => {
    mock.method(Offer, "create", async (d) => d);
    const res = await as("post", "/api/offers", FAMILY, { serviceType: "chef", description: "court", duration: "toujours", price: 10, city: "" });
    assert.equal(res.status, 400);
    for (const f of ["serviceType", "description", "duration", "price", "city"]) assert.ok(res.body.errors[f], f);
  });

  test("proposition directe : la discussion s'ouvre directement, le prix reste un budget indicatif", async () => {
    const { created, messages, notify } = setup(null);
    mock.method(User, "findById", () => lean({ _id: P1, role: "nanny", availability: "available", pricingAmount: 60000 }));
    let saved;
    mock.method(Offer, "create", async (d) => { saved = d; return { _id: OFFER_ID, ...d }; });
    const res = await as("post", "/api/offers", FAMILY, { serviceType: "nanny", description: "Garde de deux enfants à Cocody en semaine", duration: "long", city: "Abidjan", price: 55000, targetProvider: P1 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const a = saved.applications[0];
    assert.equal(a.stage, "discussion");
    assert.equal(a.proposedPrice, null);
    assert.deepEqual(a.history, []);
    assert.equal(saved.price, 55000);
    assert.equal(created.mock.callCount(), 1);
    const session = created.mock.calls[0].arguments[0];
    assert.equal(String(session._id), String(a.sessionId));
    assert.equal(session.status, "discussion");
    assert.equal(messages[0].message, chat.WELCOME_DISCUSSION);
    assert.equal(String(res.body.sessionId), String(a.sessionId));
    const n = notify.mock.calls[0].arguments[0];
    assert.equal(String(n.userId), P1);
    assert.equal(n.metadata.sessionId, String(a.sessionId));
  });

  test("proposition directe sans prix : tarif du prestataire comme budget", async () => {
    setup(null);
    mock.method(User, "findById", () => lean({ _id: P1, role: "nanny", availability: "available", pricingAmount: 60000 }));
    let saved;
    mock.method(Offer, "create", async (d) => { saved = d; return { _id: OFFER_ID, ...d }; });
    const res = await as("post", "/api/offers", FAMILY, { serviceType: "nanny", description: "Garde de deux enfants à Cocody en semaine", duration: "long", city: "Abidjan", targetProvider: P1 });
    assert.equal(res.status, 201);
    assert.equal(saved.price, 60000);
  });

  test("refuse une proposition à un prestataire en congé ou en vacances (409)", async () => {
    mock.method(User, "findById", () => lean({ _id: P1, role: "nanny", availability: "holiday", pricingAmount: 60000 }));
    const create = mock.method(Offer, "create", async (d) => d);
    const res = await as("post", "/api/offers", FAMILY, { serviceType: "nanny", description: "Garde de deux enfants à Cocody en semaine", duration: "long", city: "Abidjan", targetProvider: P1 });
    assert.equal(res.status, 409);
    assert.equal(create.mock.callCount(), 0);
  });

  test("refuse une proposition au mauvais type de prestataire (400)", async () => {
    mock.method(User, "findById", () => lean({ _id: P1, role: "tutor", availability: "available", pricingAmount: 5000 }));
    mock.method(Offer, "create", async (d) => d);
    const res = await as("post", "/api/offers", FAMILY, { serviceType: "nanny", description: "Garde de deux enfants à Cocody en semaine", duration: "long", city: "Abidjan", targetProvider: P1 });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.targetProvider);
  });
});

describe("Candidater", () => {
  afterEach(() => mock.restoreAll());

  test("sans prix : étape « applied », message joint, famille prévenue", async () => {
    const offer = fakeOffer();
    const { notify } = setup(offer);
    const res = await as("post", `/api/offers/${OFFER_ID}/apply`, NANNY1, { message: "Disponible dès lundi", proposedPrice: 60000 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const a = offer.applications[0];
    assert.equal(a.stage, "applied");
    assert.equal(a.proposedPrice, null); // le salaire se convient plus tard
    assert.deepEqual(a.history, []);
    assert.equal(a.message, "Disponible dès lundi");
    assert.equal(res.body.offer.myApplication.stage, "applied");
    assert.equal(res.body.offer.myApplication.turn, null);
    assert.equal(notify.mock.callCount(), 1);
  });

  test("offre sans budget et prestataire sans tarif : candidature possible", async () => {
    const offer = fakeOffer({ price: 0 });
    setup(offer, { pricingType: null });
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/apply`, NANNY1, {})).status, 201);
  });

  test("refuse : mauvais type de prestataire, double candidature, proposition directe, coordonnées", async () => {
    setup(fakeOffer());
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/apply`, TUTOR, {})).status, 403);
    mock.restoreAll();
    setup(fakeOffer({ applications: [application(P1)] }));
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/apply`, NANNY1, {})).status, 400);
    mock.restoreAll();
    setup(fakeOffer({ targetProvider: P1 }));
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/apply`, NANNY1, {})).status, 400);
    mock.restoreAll();
    const offer = fakeOffer();
    setup(offer);
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/apply`, NANNY1, { message: "Mon WhatsApp : 0712345678" })).status, 400);
    assert.equal(offer.applications.length, 0);
  });

  test("une famille ne peut pas candidater (403)", async () => {
    setup(fakeOffer());
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/apply`, FAMILY, {})).status, 403);
  });
});

describe("Discuter", () => {
  afterEach(() => mock.restoreAll());

  test("la famille ouvre la discussion : session privée, accueil ISD, prestataire prévenu", async () => {
    const offer = fakeOffer({ applications: [application(P1)] });
    const { created, messages, notify } = setup(offer);
    const res = await as("post", url(P1, "discuss"), FAMILY);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const a = offer.applications[0];
    assert.equal(a.stage, "discussion");
    assert.ok(a.discussionAt instanceof Date);
    const s = created.mock.calls[0].arguments[0];
    assert.equal(String(s.providerId), P1);
    assert.equal(s.status, "discussion");
    assert.equal(String(s._id), String(a.sessionId));
    assert.equal(String(res.body.sessionId), String(a.sessionId));
    assert.equal(res.body.application.stage, "discussion");
    assert.equal(res.body.activeDiscussions, 1);
    assert.equal(messages[0].senderRole, "system");
    assert.equal(notify.mock.calls[0].arguments[0].metadata.sessionId, String(a.sessionId));
  });

  test("3 discussions actives au maximum par offre (409)", async () => {
    const offer = fakeOffer({ applications: [inDiscussion(P1), inSalary(P2), inDiscussion(P3), application(P4)] });
    const { created } = setup(offer);
    const res = await as("post", url(P4, "discuss"), FAMILY);
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "Vous discutez déjà avec 3 prestataires : terminez une discussion pour en ouvrir une autre.");
    assert.equal(offer.applications[3].stage, "applied");
    assert.equal(created.mock.callCount(), 0);
  });

  test("une discussion terminée libère une place", async () => {
    const offer = fakeOffer({ applications: [inDiscussion(P1), inSalary(P2), application(P3, { status: "rejected", stage: "rejected" }), application(P4)] });
    setup(offer);
    assert.equal((await as("post", url(P4, "discuss"), FAMILY)).status, 201);
  });

  test("réservé à la famille propriétaire ; déjà ouverte : idempotent ; candidature traitée ou offre fermée refusées", async () => {
    setup(fakeOffer({ applications: [application(P1)] }));
    assert.equal((await as("post", url(P1, "discuss"), tokenFor(OTHER_FAMILY, "family"))).status, 403);
    assert.equal((await as("post", url(P1, "discuss"), NANNY1)).status, 403);
    mock.restoreAll();
    const { created } = setup(fakeOffer({ applications: [inDiscussion(P1)] }), { sessions: { [P1]: {} } });
    const again = await as("post", url(P1, "discuss"), FAMILY);
    assert.equal(again.status, 200);
    assert.equal(again.body.sessionId, `s-${P1}`);
    assert.equal(created.mock.callCount(), 0);
    mock.restoreAll();
    setup(fakeOffer({ applications: [application(P1, { status: "rejected", stage: "rejected" })] }));
    assert.equal((await as("post", url(P1, "discuss"), FAMILY)).status, 400);
    mock.restoreAll();
    setup(fakeOffer({ status: "closed", applications: [application(P1)] }));
    assert.equal((await as("post", url(P1, "discuss"), FAMILY)).status, 400);
  });

  test("ancien index unique encore en base : 503 clair, la candidature reste à l'étape précédente", async () => {
    const offer = fakeOffer({ applications: [application(P1)] });
    setup(offer);
    mock.method(ChatSession, "create", async () => { const e = new Error("dup"); e.code = 11000; throw e; });
    const res = await as("post", url(P1, "discuss"), FAMILY);
    assert.equal(res.status, 503);
    assert.equal(offer.applications[0].stage, "applied");
    assert.equal(offer.applications[0].sessionId, null);
  });
});

describe("Accord sur la mission", () => {
  afterEach(() => mock.restoreAll());

  test("chacun confirme ; les deux d'accord : étape salaire et message ISD", async () => {
    const offer = fakeOffer({ applications: [inDiscussion(P1)] });
    const { messages, notify } = setup(offer, { sessions: { [P1]: {} } });
    const r1 = await as("post", url(P1, "mission-agreement"), FAMILY, { agree: true });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.application.stage, "discussion");
    assert.ok(r1.body.application.missionAgreed.family);
    assert.equal(messages[0].meta.kind, "mission_agree");
    const r2 = await as("post", url(P1, "mission-agreement"), NANNY1, { agree: true });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.application.stage, "salary");
    assert.equal(r2.body.application.turn, "either");
    const card = messages.at(-1);
    assert.equal(card.type, "mission_agreed");
    assert.equal(card.message, "✅ Mission validée par la famille et par le prestataire : vous pouvez maintenant convenir du salaire.");
    assert.equal(card.sessionId, `s-${P1}`);
    assert.equal(notify.mock.callCount(), 2);
  });

  test("retrait de son accord tant que l'autre n'a pas confirmé ; impossible une fois la mission validée", async () => {
    const offer = fakeOffer({ applications: [inDiscussion(P1, { missionAgreed: { family: new Date(), provider: null } })] });
    const { messages } = setup(offer, { sessions: { [P1]: {} } });
    const r = await as("post", url(P1, "mission-agreement"), FAMILY, { agree: false });
    assert.equal(r.status, 200);
    assert.equal(offer.applications[0].missionAgreed.family, null);
    assert.equal(messages[0].meta.kind, "mission_agree_withdrawn");
    mock.restoreAll();
    setup(fakeOffer({ applications: [inSalary(P1)] }), { sessions: { [P1]: {} } });
    assert.equal((await as("post", url(P1, "mission-agreement"), NANNY1, { agree: false })).status, 409);
  });

  test("refuse : réponse invalide, étape candidature, autre prestataire, autre famille", async () => {
    setup(fakeOffer({ applications: [application(P1), inDiscussion(P2)] }));
    assert.equal((await as("post", url(P1, "mission-agreement"), FAMILY, { agree: "oui" })).status, 400);
    assert.equal((await as("post", url(P1, "mission-agreement"), FAMILY, { agree: true })).status, 409);
    assert.equal((await as("post", url(P2, "mission-agreement"), NANNY1, { agree: true })).status, 403);
    assert.equal((await as("post", url(P2, "mission-agreement"), tokenFor(OTHER_FAMILY, "family"), { agree: true })).status, 403);
  });
});

describe("Négociation du salaire", () => {
  afterEach(() => mock.restoreAll());

  test("aucune proposition de prix avant l'accord sur la mission (409)", async () => {
    const offer = fakeOffer({ applications: [application(P1), inDiscussion(P2)] });
    setup(offer);
    assert.equal((await as("post", url(P1, "counter"), FAMILY, { amount: 45000 })).status, 409);
    const res = await as("post", url(P2, "counter"), NANNY2, { amount: 45000 });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /mission validée/);
    assert.deepEqual(offer.applications[1].history, []);
  });

  test("première proposition par le prestataire, puis chacun son tour ; cartes dans le chat", async () => {
    const offer = fakeOffer({ applications: [inSalary(P1)] });
    const { messages, cards, notify } = setup(offer, { sessions: { [P1]: { status: "discussion" } } });
    const r1 = await as("post", url(P1, "counter"), NANNY1, { amount: 60000 });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.application.turn, "family");
    assert.deepEqual(r1.body.application.countersLeft, { family: 3, provider: 3 }); // la 1re ne compte pas
    const card = messages[0];
    assert.equal(card.type, "price_offer");
    assert.equal(card.senderRole, "provider");
    assert.deepEqual({ ...card.meta }, { kind: "price_offer", amount: 60000, unit: "month", by: "provider", status: "pending", round: 1 });
    assert.match(card.message, /60\s000 FCFA par mois/);
    assert.equal(r1.body.card.familyId, undefined);
    // Le prestataire ne peut pas rejouer avant la réponse
    assert.equal((await as("post", url(P1, "counter"), NANNY1, { amount: 58000 })).status, 409);
    const r2 = await as("post", url(P1, "counter"), FAMILY, { amount: 52000 });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.application.countersLeft.family, 2);
    // L'ancienne carte est marquée remplacée
    assert.equal(cards.mock.calls[0].arguments[1].$set["meta.status"], "replaced");
    assert.equal(String(cards.mock.calls[0].arguments[0]), String(card._id));
    const a = offer.applications[0];
    assert.deepEqual(a.history.map((h) => [h.by, h.amount]), [["provider", 60000], ["family", 52000]]);
    assert.equal(a.proposedPrice, 52000);
    assert.equal(notify.mock.callCount(), 2);
    assert.equal(notify.mock.calls[1].arguments[0].metadata.sessionId, `s-${P1}`);
  });

  test("la famille peut aussi faire la première proposition", async () => {
    const offer = fakeOffer({ applications: [inSalary(P1)] });
    setup(offer, { sessions: { [P1]: {} } });
    const res = await as("post", url(P1, "counter"), FAMILY, { amount: 45000 });
    assert.equal(res.status, 200);
    assert.equal(res.body.application.turn, "provider");
  });

  test("3 contre-propositions maximum par partie (409)", async () => {
    const history = [
      { by: "provider", amount: 50000 }, { by: "family", amount: 40000 }, { by: "provider", amount: 48000 },
      { by: "family", amount: 42000 }, { by: "provider", amount: 47000 }, { by: "family", amount: 44000 }, { by: "provider", amount: 46000 },
    ];
    setup(fakeOffer({ applications: [inSalary(P1, history)] }), { sessions: { [P1]: {} } });
    const res = await as("post", url(P1, "counter"), FAMILY, { amount: 45000 });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /3 contre-propositions/);
  });

  test("refuse : autre famille, autre prestataire, même prix, montant invalide, offre fermée", async () => {
    setup(fakeOffer({ applications: [inSalary(P1, [{ by: "provider", amount: 50000 }])] }), { sessions: { [P1]: {} } });
    assert.equal((await as("post", url(P1, "counter"), tokenFor(OTHER_FAMILY, "family"), { amount: 45000 })).status, 403);
    assert.equal((await as("post", url(P1, "counter"), NANNY2, { amount: 45000 })).status, 403);
    assert.equal((await as("post", url(P1, "counter"), FAMILY, { amount: 50000 })).status, 400);
    assert.equal((await as("post", url(P1, "counter"), FAMILY, { amount: "45000" })).status, 400);
    assert.equal((await as("post", url(P1, "counter"), FAMILY, { amount: 100 })).status, 400);
    mock.restoreAll();
    setup(fakeOffer({ status: "closed", applications: [inSalary(P1)] }));
    assert.equal((await as("post", url(P1, "counter"), FAMILY, { amount: 45000 })).status, 400);
  });

  test("conflit d'écriture simultanée → 409 au lieu d'une erreur serveur", async () => {
    const offer = fakeOffer({ applications: [inSalary(P1)], async save() { const e = new Error("No matching document"); e.name = "VersionError"; throw e; } });
    setup(offer);
    assert.equal((await as("post", url(P1, "counter"), FAMILY, { amount: 45000 })).status, 409);
  });
});

describe("Accord sur le salaire", () => {
  afterEach(() => mock.restoreAll());

  test("la famille accepte le prix du prestataire : accord conclu, autres refusés, discussions fermées poliment", async () => {
    const offer = fakeOffer({ applications: [
      inSalary(P1, [{ by: "provider", amount: 48000 }], { priceCardId: "card1" }),
      inDiscussion(P2),
      application(P3),
      application(P4, { status: "rejected", stage: "rejected" }),
    ] });
    const { notify, store, messages, cards } = setup(offer, { sessions: { [P1]: {}, [P2]: {} } });
    const res = await as("post", `/api/offers/${OFFER_ID}/accept/${P1}`, FAMILY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(offer.status, "closed");
    assert.equal(offer.agreedPrice, 48000);
    assert.equal(offer.acceptedProvider, P1);
    assert.deepEqual(offer.applications.map((a) => a.stage), ["accepted", "rejected", "rejected", "rejected"]);
    assert.deepEqual(offer.applications.map((a) => a.status), ["accepted", "rejected", "rejected", "rejected"]);
    assert.equal(offer.applications[1].closedReason, "other_chosen");
    // Discussion de l'accord : active, carte acceptée, message « prix accepté »
    assert.equal(store[P1].status, "active");
    assert.equal(cards.mock.calls[0].arguments[1].$set["meta.status"], "accepted");
    const accepted = messages.find((m) => m.type === "price_accepted");
    assert.equal(accepted.providerId, P1);
    assert.equal(accepted.meta.amount, 48000);
    // Discussion du concurrent : fermée avec le message poli
    assert.equal(store[P2].status, "closed");
    assert.equal(store[P2].closedReason, "other_chosen");
    const closed = messages.find((m) => m.type === "discussion_closed");
    assert.equal(closed.providerId, P2);
    assert.equal(closed.message, "La famille a choisi un autre prestataire pour cette offre. Merci pour cet échange ! D'autres offres vous attendent.");
    // 1 acceptation + 2 refus automatiques (le candidat déjà refusé n'est pas re-notifié)
    assert.equal(notify.mock.callCount(), 3);
  });

  test("la famille ne peut accepter ni sa propre proposition, ni sans proposition, ni avant l'étape salaire (409)", async () => {
    const offer = fakeOffer({ applications: [inSalary(P1, [{ by: "family", amount: 45000 }]), inSalary(P2), inDiscussion(P3)] });
    setup(offer);
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/accept/${P1}`, FAMILY)).status, 409);
    const none = await as("post", `/api/offers/${OFFER_ID}/accept/${P2}`, FAMILY);
    assert.equal(none.status, 409);
    assert.match(none.body.message, /proposition/);
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/accept/${P3}`, FAMILY)).status, 409);
    assert.equal(offer.status, "open");
  });

  test("le prestataire accepte la proposition de la famille (ancienne et nouvelle route)", async () => {
    for (const route of [`/api/offers/${OFFER_ID}/accept-proposal`, url(P1, "accept")]) {
      const offer = fakeOffer({ targetProvider: P1, applications: [inSalary(P1, [{ by: "family", amount: 55000 }])] });
      const { notify } = setup(offer, { sessions: { [P1]: {} } });
      const res = await as("post", route, NANNY1);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(offer.status, "closed");
      assert.equal(res.body.offer.agreedPrice, 55000);
      assert.equal(res.body.application.stage, "accepted");
      assert.equal(notify.mock.calls[0].arguments[0].userId, FAMILY_ID);
      mock.restoreAll();
    }
  });

  test("le prestataire ne peut pas accepter son propre prix (409) ni une offre qui ne le concerne pas (404)", async () => {
    setup(fakeOffer({ applications: [inSalary(P1, [{ by: "provider", amount: 50000 }])] }));
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/accept-proposal`, NANNY1)).status, 409);
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/accept-proposal`, NANNY2)).status, 404);
    assert.equal((await as("post", url(P1, "accept"), NANNY2)).status, 403);
  });

  test("ancienne discussion sans session : l'accord rouvre le chat avec l'accueil", async () => {
    const offer = fakeOffer({ applications: [inSalary(P1, [{ by: "provider", amount: 50000 }])] });
    const { created, messages } = setup(offer);
    const res = await as("post", `/api/offers/${OFFER_ID}/accept/${P1}`, FAMILY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(created.mock.callCount(), 1);
    assert.equal(created.mock.calls[0].arguments[0].status, "active");
    assert.equal(messages[0].message, chat.WELCOME);
  });
});

describe("Refus, retrait, fermeture", () => {
  afterEach(() => mock.restoreAll());

  test("la famille refuse en pleine discussion : discussion fermée avec un message neutre", async () => {
    const offer = fakeOffer({ applications: [inSalary(P1, [{ by: "provider", amount: 50000 }])] });
    const { store, messages, notify } = setup(offer, { sessions: { [P1]: {} } });
    const res = await as("post", url(P1, "reject"), FAMILY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.application.stage, "rejected");
    assert.equal(store[P1].status, "closed");
    assert.equal(store[P1].closedBy, "family");
    assert.equal(messages[0].type, "discussion_closed");
    assert.equal(messages[0].meta.reason, "rejected");
    assert.equal(String(notify.mock.calls[0].arguments[0].userId), P1);
    assert.equal((await as("post", url(P1, "reject"), FAMILY)).status, 400);
  });

  test("le prestataire se retire en discussion : discussion fermée, famille prévenue", async () => {
    const offer = fakeOffer({ applications: [inDiscussion(P1)] });
    const { store, messages, notify } = setup(offer, { sessions: { [P1]: {} } });
    const res = await as("delete", `/api/offers/${OFFER_ID}/withdraw`, NANNY1);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(offer.applications[0].stage, "withdrawn");
    assert.equal(offer.applications[0].status, "withdrawn");
    assert.equal(store[P1].status, "closed");
    assert.equal(messages[0].meta.reason, "withdrawn");
    assert.equal(String(notify.mock.calls[0].arguments[0].userId), FAMILY_ID);
  });

  test("retrait avant toute discussion : candidature retirée, impossible de recandidater", async () => {
    const offer = fakeOffer({ applications: [application(P1)] });
    setup(offer);
    const res = await as("post", `/api/offers/${OFFER_ID}/withdraw`, NANNY1);
    assert.equal(res.status, 200);
    assert.equal(offer.applications.length, 1);
    assert.equal(offer.applications[0].stage, "withdrawn");
    const again = await as("post", `/api/offers/${OFFER_ID}/apply`, NANNY1, {});
    assert.equal(again.status, 400);
    assert.equal(again.body.message, "Vous vous êtes retiré de cette offre : vous ne pouvez plus y candidater.");
  });

  test("proposition directe : se retirer = décliner, l'offre est fermée", async () => {
    const offer = fakeOffer({ targetProvider: P1, applications: [inDiscussion(P1)] });
    const { store } = setup(offer, { sessions: { [P1]: {} } });
    assert.equal((await as("delete", `/api/offers/${OFFER_ID}/withdraw`, NANNY1)).status, 200);
    assert.equal(offer.status, "closed");
    assert.equal(store[P1].closedReason, "declined");
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/decline`, NANNY1)).status, 400);
  });

  test("une offre avec accord ne peut plus être supprimée (400)", async () => {
    const offer = fakeOffer({ status: "closed", acceptedProvider: P1, applications: [application(P1, { status: "accepted", stage: "accepted" })], deleteOne: mock.fn(async () => {}) });
    setup(offer);
    assert.equal((await as("delete", `/api/offers/${OFFER_ID}`, FAMILY)).status, 400);
    assert.equal(offer.deleteOne.mock.callCount(), 0);
  });

  test("fermer une offre refuse les candidatures en cours et ferme leurs discussions", async () => {
    const offer = fakeOffer({ applications: [inDiscussion(P1), application(P2), application(P3, { status: "rejected", stage: "rejected" })] });
    const { notify, store } = setup(offer, { sessions: { [P1]: {} } });
    assert.equal((await as("put", `/api/offers/${OFFER_ID}/cancel`, FAMILY)).status, 200);
    assert.deepEqual(offer.applications.map((a) => a.status), ["rejected", "rejected", "rejected"]);
    assert.equal(store[P1].status, "closed");
    assert.equal(store[P1].closedReason, "offer_closed");
    assert.equal(notify.mock.callCount(), 2);
  });
});

describe("Vue prestataire : confidentialité", () => {
  afterEach(() => mock.restoreAll());

  const findChain = (docs, calls) => {
    const q = {
      populate(path, fields) { calls.populate = { path, fields }; return q; },
      sort() { return q; },
      then(resolve, reject) { return Promise.resolve(docs).then(resolve, reject); },
    };
    return q;
  };

  test("/my-applications : ni téléphone de la famille, ni candidatures ni prix des concurrents", async () => {
    const calls = {};
    const doc = fakeOffer({ family: { _id: FAMILY_ID, firstName: "Awa" }, applications: [
      inSalary(P1, [{ by: "provider", amount: 50000 }]),
      inSalary(P2, [{ by: "provider", amount: 31234 }]),
    ] });
    mock.method(Offer, "find", () => findChain([doc], calls));
    const res = await as("get", "/api/offers/my-applications", NANNY1);
    assert.equal(res.status, 200);
    assert.ok(!calls.populate.fields.includes("phone") && !calls.populate.fields.includes("email"));
    const o = res.body[0];
    assert.equal(o.applications, undefined);
    assert.equal(o.applicantsCount, 2);
    assert.equal(o.myApplication.proposedPrice, 50000);
    assert.equal(o.myApplication.stage, "salary");
    assert.equal(o.myApplication.sessionId, `s-${P1}`);
    assert.equal(o.myApplication.turn, "family");
    assert.ok(!JSON.stringify(res.body).includes("31234"));
    assert.ok(!JSON.stringify(res.body).includes(P2));
  });

  test("/available : même règle", async () => {
    const calls = {};
    mock.method(Offer, "find", () => findChain([fakeOffer({ applications: [inDiscussion(P2)] })], calls));
    const res = await as("get", "/api/offers/available", NANNY1);
    assert.equal(res.status, 200);
    assert.ok(!calls.populate.fields.includes("phone"));
    assert.equal(res.body[0].applications, undefined);
    assert.equal(res.body[0].myApplication, null);
  });

  test("/my (famille) : ni téléphone ni email des prestataires ; étapes, tours, compteurs et places de discussion", async () => {
    const calls = {};
    mock.method(Offer, "find", () => findChain([fakeOffer({ applications: [application(P1), inSalary(P2, [{ by: "provider", amount: 50000 }])] })], calls));
    const res = await as("get", "/api/offers/my", FAMILY);
    assert.equal(res.status, 200);
    assert.ok(!/\bphone\b|\bemail\b|password/.test(calls.populate.fields));
    const [a1, a2] = res.body[0].applications;
    assert.equal(a1.stage, "applied");
    assert.equal(a1.turn, null);
    assert.equal(a2.turn, "family");
    assert.deepEqual(a2.countersLeft, { family: 3, provider: 3 });
    assert.equal(res.body[0].activeDiscussions, 1);
    assert.equal(res.body[0].maxDiscussions, 3);
  });
});

describe("Candidatures créées avant les étapes", () => {
  afterEach(() => mock.restoreAll());

  test("ancienne candidature (prix déjà proposé, sans étape) : d'abord discuter, pas d'accord direct", async () => {
    const legacy = { provider: P1, status: "pending", proposedPrice: 50000, lastOfferBy: "provider", history: [{ by: "provider", amount: 50000 }] };
    const offer = fakeOffer({ applications: [legacy] });
    setup(offer);
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/accept/${P1}`, FAMILY)).status, 409);
    assert.equal((await as("post", url(P1, "counter"), FAMILY, { amount: 45000 })).status, 409);
    assert.equal(offer.status, "open");
  });
});

describe("Revue de sécurité : négociation", () => {
  afterEach(() => mock.restoreAll());

  test("discussion fermée par ISD : plus d'accord sur la mission, de proposition ni d'accord sur le salaire (409)", async () => {
    const offer = fakeOffer({ applications: [inDiscussion(P1), inSalary(P2, [{ by: "provider", amount: 50000 }])] });
    setup(offer, { sessions: { [P1]: { status: "closed", closedReason: "contact_sharing" }, [P2]: { status: "closed", closedReason: "contact_sharing" } } });
    for (const [path, token, body] of [
      [url(P1, "mission-agreement"), FAMILY, { agree: true }],
      [url(P2, "counter"), FAMILY, { amount: 45000 }],
      [url(P2, "accept"), FAMILY, undefined],
    ]) {
      const res = await as("post", path, token, body);
      assert.equal(res.status, 409, path);
      assert.equal(res.body.message, "Ce chat est fermé.");
    }
    assert.equal(offer.status, "open");
  });

  test("unité figée : chaque proposition garde son unité, l'accord fixe offer.agreedUnit", async () => {
    const offer = fakeOffer({ applications: [inSalary(P1)] });
    const { messages } = setup(offer, { sessions: { [P1]: {} }, pricingType: "hour" });
    assert.equal((await as("post", url(P1, "counter"), NANNY1, { amount: 2500 })).status, 200);
    assert.equal(offer.applications[0].history[0].unit, "hour");
    assert.equal(messages[0].meta.unit, "hour");
    const res = await as("post", url(P1, "accept"), FAMILY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(offer.agreedUnit, "hour");
    assert.equal(res.body.application.history[0].unit, "hour");
  });

  test("montants : multiples de 500 FCFA (proposition et budget d'offre)", async () => {
    setup(fakeOffer({ applications: [inSalary(P1)] }), { sessions: { [P1]: {} } });
    const res = await as("post", url(P1, "counter"), FAMILY, { amount: 45250 });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "Le montant doit être un multiple de 500 FCFA.");
    mock.restoreAll();
    mock.method(Offer, "create", async (d) => d);
    const offerRes = await as("post", "/api/offers", FAMILY, { serviceType: "nanny", description: "Garde de deux enfants à Cocody en semaine", duration: "long", city: "Abidjan", price: 55250 });
    assert.equal(offerRes.status, 400);
    assert.equal(offerRes.body.errors.price, "Le montant doit être un multiple de 500 FCFA.");
  });

  test("accord sur la mission : pas de bascule en rafale (429) ni plus de 6 changements (409)", async () => {
    const offer = fakeOffer({ applications: [inDiscussion(P1)] });
    setup(offer, { sessions: { [P1]: {} } });
    assert.equal((await as("post", url(P1, "mission-agreement"), FAMILY, { agree: true })).status, 200);
    const fast = await as("post", url(P1, "mission-agreement"), FAMILY, { agree: false });
    assert.equal(fast.status, 429);
    assert.ok(offer.applications[0].missionAgreed.family); // inchangé
    mock.restoreAll();
    setup(fakeOffer({ applications: [inDiscussion(P1, { missionToggles: 6 })] }), { sessions: { [P1]: {} } });
    const many = await as("post", url(P1, "mission-agreement"), NANNY1, { agree: true });
    assert.equal(many.status, 409);
    assert.match(many.body.message, /trop souvent/);
  });

  test("plafond de 6 discussions par famille, toutes offres confondues (409)", async () => {
    const others = [{ applications: [inDiscussion(P2), inSalary(P3), inDiscussion(P4)] }, { applications: [inDiscussion(P2), inDiscussion(P3), inSalary(P4)] }];
    const offer = fakeOffer({ applications: [application(P1)] });
    const { created, familyQuery } = setup(offer, { familyOffers: others });
    const res = await as("post", url(P1, "discuss"), FAMILY);
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "Vous avez déjà 6 discussions en cours (toutes offres confondues) : terminez-en une avant d'en ouvrir une nouvelle.");
    assert.equal(created.mock.callCount(), 0);
    assert.equal(String(familyQuery.mock.calls[0].arguments[0].family), FAMILY_ID);
    // Proposition directe : même plafond
    mock.method(User, "findById", () => lean({ _id: P1, role: "nanny", availability: "available", pricingAmount: 60000 }));
    const create = mock.method(Offer, "create", async (d) => d);
    const direct = await as("post", "/api/offers", FAMILY, { serviceType: "nanny", description: "Garde de deux enfants à Cocody en semaine", duration: "long", city: "Abidjan", targetProvider: P1 });
    assert.equal(direct.status, 409);
    assert.equal(create.mock.callCount(), 0);
  });

  test("coordonnées refusées dans une candidature : tentative comptée", async () => {
    setup(fakeOffer());
    const strikes = mock.method(User, "findByIdAndUpdate", () => ({ select() { return this; }, lean: async () => ({ contactStrikes: 1 }) }));
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/apply`, NANNY1, { message: "Mon WhatsApp : 0712345678" })).status, 400);
    assert.deepEqual(strikes.mock.calls[0].arguments[1], { $inc: { contactStrikes: 1 } });
  });

  test("notifications « Candidature non retenue » et « Candidature retirée » : avec la discussion", async () => {
    const offer = fakeOffer({ applications: [inSalary(P1, [{ by: "provider", amount: 50000 }]), inDiscussion(P2)] });
    const { notify } = setup(offer, { sessions: { [P1]: {}, [P2]: {} } });
    await as("post", `/api/offers/${OFFER_ID}/accept/${P1}`, FAMILY);
    const notRetained = notify.mock.calls.map((c) => c.arguments[0]).find((n) => n.title === "Candidature non retenue");
    assert.equal(notRetained.metadata.sessionId, `s-${P2}`);
    mock.restoreAll();
    const o2 = fakeOffer({ applications: [inDiscussion(P1)] });
    const s2 = setup(o2, { sessions: { [P1]: {} } });
    await as("post", url(P1, "reject"), FAMILY);
    assert.equal(s2.notify.mock.calls.at(-1).arguments[0].metadata.sessionId, `s-${P1}`);
    mock.restoreAll();
    const o3 = fakeOffer({ applications: [inDiscussion(P1)] });
    const s3 = setup(o3, { sessions: { [P1]: {} } });
    await as("delete", `/api/offers/${OFFER_ID}/withdraw`, NANNY1);
    const retired = s3.notify.mock.calls.at(-1).arguments[0];
    assert.equal(retired.title, "Candidature retirée");
    assert.equal(retired.metadata.sessionId, `s-${P1}`);
  });

  test("noms réduits à l'initiale avant paiement : /available (famille) et /my (prestataires)", async () => {
    const findChain = (docs) => { const q = { populate() { return q; }, sort() { return q; }, then: (r, j) => Promise.resolve(docs).then(r, j) }; return q; };
    mock.method(Offer, "find", () => findChain([fakeOffer({ family: { _id: FAMILY_ID, firstName: "Awa", lastName: "Kouassi" }, applications: [] })]));
    const av = await as("get", "/api/offers/available", NANNY1);
    assert.equal(av.body[0].family.lastName, "K.");
    assert.equal(av.body[0].family.firstName, "Awa");
    mock.restoreAll();
    const prov = (id, lastName) => ({ _id: id, firstName: "Aya", lastName });
    mock.method(Offer, "find", () => findChain([
      fakeOffer({ applications: [application(prov(P1, "Yao")), application(prov(P2, "N'Guessan"))] }),
      fakeOffer({ status: "closed", paidAt: new Date(), acceptedProvider: P1, applications: [application(prov(P1, "Yao"), { status: "accepted", stage: "accepted" })] }),
    ]));
    const my = await as("get", "/api/offers/my", FAMILY);
    assert.deepEqual(my.body[0].applications.map((a) => a.provider.lastName), ["Y.", "N."]);
    assert.equal(my.body[1].applications[0].provider.lastName, "Yao"); // accord payé : nom complet
  });

  test("limites par compte : propositions directes (10/jour) et candidatures/retraits (20/heure)", async () => {
    const { limiters } = require("../routes/offerRoutes");
    limiters.applyLimiter.reset();
    setup(fakeOffer({ applications: [application(P1)] }));
    const token = tokenFor(P3, "nanny");
    let last;
    for (let i = 0; i < 21; i += 1) last = await as("post", `/api/offers/${OFFER_ID}/apply`, token, { message: 123 });
    assert.equal(last.status, 429);
    assert.match(last.body.message, /Trop de candidatures/);
    limiters.applyLimiter.reset();
    limiters.directOfferLimiter.reset();
    mock.method(User, "findById", () => lean({ _id: P1, role: "nanny", availability: "holiday" }));
    const fam = tokenFor("64b0000000000000000000a9", "family");
    for (let i = 0; i < 11; i += 1) last = await as("post", "/api/offers", fam, { serviceType: "nanny", description: "Garde de deux enfants à Cocody en semaine", duration: "long", city: "Abidjan", targetProvider: P1 });
    assert.equal(last.status, 429);
    assert.match(last.body.message, /propositions directes/);
    limiters.directOfferLimiter.reset();
    limiters.offerWriteLimiter.reset();
  });
});
