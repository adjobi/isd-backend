const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const Offer = require("../models/Offer");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { ChatSession, ChatMessage } = require("../models/Chat");
const { tokenFor, buildApp } = require("./helpers");

const app = buildApp();
const FAMILY_ID = "64b0000000000000000000a1";
const OTHER_FAMILY = "64b0000000000000000000a2";
const OFFER_ID = "64b0000000000000000000b1";
const P1 = "64b0000000000000000000c1";
const P2 = "64b0000000000000000000c2";
const FAMILY = tokenFor(FAMILY_ID, "family");
const NANNY1 = tokenFor(P1, "nanny");
const NANNY2 = tokenFor(P2, "nanny");
const TUTOR = tokenFor(P2, "tutor");

const application = (provider, extra = {}) => ({ provider, status: "pending", proposedPrice: 50000, lastOfferBy: "provider", history: [{ by: "provider", amount: 50000 }], ...extra });
const fakeOffer = (extra = {}) => ({
  _id: OFFER_ID, family: FAMILY_ID, serviceType: "nanny", status: "open", price: 50000, targetProvider: null,
  applications: [], saves: 0, async save() { this.saves += 1; }, ...extra,
});
const setup = (offer) => {
  mock.method(Offer, "findById", async () => offer);
  mock.method(ChatSession, "findOne", async () => null);
  mock.method(ChatSession, "create", async (d) => ({ ...d, _id: "chat" }));
  mock.method(ChatMessage, "create", async (d) => d);
  return mock.method(Notification, "create", async () => ({}));
};
const as = (method, url, token, body) => {
  const r = request(app)[method](url).set("Authorization", `Bearer ${token}`);
  return body ? r.send(body) : r;
};
const lean = (doc) => ({ select() { return this; }, lean: async () => doc });

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

  test("proposition directe : candidature créée avec le prix de la famille, c'est au prestataire de répondre", async () => {
    mock.method(User, "findById", () => lean({ _id: P1, role: "nanny", availability: "available", pricingAmount: 60000 }));
    let saved;
    mock.method(Offer, "create", async (d) => { saved = d; return { _id: OFFER_ID, ...d }; });
    const notify = mock.method(Notification, "create", async () => ({}));
    const res = await as("post", "/api/offers", FAMILY, { serviceType: "nanny", description: "Garde de deux enfants à Cocody en semaine", duration: "long", city: "Abidjan", price: 55000, targetProvider: P1 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const a = saved.applications[0];
    assert.equal(a.proposedPrice, 55000);
    assert.equal(a.lastOfferBy, "family");
    assert.deepEqual(a.history.map((h) => [h.by, h.amount]), [["family", 55000]]);
    assert.equal(notify.mock.callCount(), 1);
  });

  test("proposition directe sans prix : tarif du prestataire", async () => {
    mock.method(User, "findById", () => lean({ _id: P1, role: "nanny", availability: "available", pricingAmount: 60000 }));
    let saved;
    mock.method(Offer, "create", async (d) => { saved = d; return d; });
    mock.method(Notification, "create", async () => ({}));
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

  test("candidature avec un autre prix : historique et tour de la famille", async () => {
    const offer = fakeOffer();
    const notify = setup(offer);
    const res = await as("post", `/api/offers/${OFFER_ID}/apply`, NANNY1, { proposedPrice: 60000, message: "Disponible dès lundi" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const a = offer.applications[0];
    assert.equal(a.proposedPrice, 60000);
    assert.equal(a.lastOfferBy, "provider");
    assert.equal(a.message, "Disponible dès lundi");
    assert.equal(res.body.offer.myApplication.turn, "family");
    assert.equal(notify.mock.callCount(), 1);
  });

  test("sans prix : celui de l'offre", async () => {
    const offer = fakeOffer();
    setup(offer);
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/apply`, NANNY1, {})).status, 201);
    assert.equal(offer.applications[0].proposedPrice, 50000);
  });

  test("offre sans budget et prestataire sans tarif : prix demandé (400)", async () => {
    const offer = fakeOffer({ price: 0 });
    setup(offer);
    mock.method(User, "findById", () => lean({ pricingAmount: null }));
    const res = await as("post", `/api/offers/${OFFER_ID}/apply`, NANNY1, {});
    assert.equal(res.status, 400);
    assert.equal(offer.applications.length, 0);
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

describe("Contre-proposition", () => {
  afterEach(() => mock.restoreAll());
  const url = (p) => `/api/offers/${OFFER_ID}/applications/${p}/counter`;

  test("la famille contre-propose, puis le prestataire, chacun son tour", async () => {
    const offer = fakeOffer({ applications: [application(P1)] });
    const notify = setup(offer);
    const r1 = await as("post", url(P1), FAMILY, { amount: 45000 });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.application.turn, "provider");
    assert.equal(r1.body.application.countersLeft.family, 2);
    // La famille ne peut pas rejouer avant la réponse
    assert.equal((await as("post", url(P1), FAMILY, { amount: 44000 })).status, 409);
    const r2 = await as("post", url(P1), NANNY1, { amount: 48000 });
    assert.equal(r2.status, 200);
    const a = offer.applications[0];
    assert.deepEqual(a.history.map((h) => [h.by, h.amount]), [["provider", 50000], ["family", 45000], ["provider", 48000]]);
    assert.equal(a.proposedPrice, 48000);
    assert.equal(notify.mock.callCount(), 2);
  });

  test("3 contre-propositions maximum par partie (409)", async () => {
    const history = [
      { by: "provider", amount: 50000 }, { by: "family", amount: 40000 }, { by: "provider", amount: 48000 },
      { by: "family", amount: 42000 }, { by: "provider", amount: 47000 }, { by: "family", amount: 44000 }, { by: "provider", amount: 46000 },
    ];
    const offer = fakeOffer({ applications: [application(P1, { history, proposedPrice: 46000, lastOfferBy: "provider" })] });
    setup(offer);
    const res = await as("post", url(P1), FAMILY, { amount: 45000 });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /3 contre-propositions/);
  });

  test("refuse : autre famille, autre prestataire, même prix, montant invalide, offre fermée", async () => {
    setup(fakeOffer({ applications: [application(P1)] }));
    assert.equal((await as("post", url(P1), tokenFor(OTHER_FAMILY, "family"), { amount: 45000 })).status, 403);
    assert.equal((await as("post", url(P1), NANNY2, { amount: 45000 })).status, 403);
    assert.equal((await as("post", url(P1), FAMILY, { amount: 50000 })).status, 400);
    assert.equal((await as("post", url(P1), FAMILY, { amount: "45000" })).status, 400);
    assert.equal((await as("post", url(P1), FAMILY, { amount: 100 })).status, 400);
    mock.restoreAll();
    setup(fakeOffer({ status: "closed", applications: [application(P1)] }));
    assert.equal((await as("post", url(P1), FAMILY, { amount: 45000 })).status, 400);
  });

  test("conflit d'écriture simultanée → 409 au lieu d'une erreur serveur", async () => {
    const offer = fakeOffer({ applications: [application(P1)], async save() { const e = new Error("No matching document"); e.name = "VersionError"; throw e; } });
    setup(offer);
    const res = await as("post", url(P1), FAMILY, { amount: 45000 });
    assert.equal(res.status, 409);
  });
});

describe("Accord", () => {
  afterEach(() => mock.restoreAll());

  test("la famille accepte le prix du prestataire : prix convenu, autres refusés et prévenus", async () => {
    const offer = fakeOffer({ applications: [application(P1, { proposedPrice: 48000 }), application(P2), application("64b0000000000000000000c3", { status: "rejected" })] });
    const notify = setup(offer);
    const res = await as("post", `/api/offers/${OFFER_ID}/accept/${P1}`, FAMILY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(offer.status, "closed");
    assert.equal(offer.agreedPrice, 48000);
    assert.equal(offer.acceptedProvider, P1);
    assert.deepEqual(offer.applications.map((a) => a.status), ["accepted", "rejected", "rejected"]);
    // 1 acceptation + 1 refus automatique (le candidat déjà refusé n'est pas re-notifié)
    assert.equal(notify.mock.callCount(), 2);
  });

  test("la famille ne peut pas accepter sa propre contre-proposition (409)", async () => {
    const offer = fakeOffer({ applications: [application(P1, { lastOfferBy: "family", proposedPrice: 45000 })] });
    setup(offer);
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/accept/${P1}`, FAMILY)).status, 409);
    assert.equal(offer.status, "open");
  });

  test("le prestataire accepte la proposition de la famille : accord immédiat", async () => {
    const offer = fakeOffer({ targetProvider: P1, applications: [application(P1, { lastOfferBy: "family", proposedPrice: 55000, history: [{ by: "family", amount: 55000 }] })] });
    const notify = setup(offer);
    const res = await as("post", `/api/offers/${OFFER_ID}/accept-proposal`, NANNY1);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(offer.status, "closed");
    assert.equal(offer.agreedPrice, 55000);
    assert.equal(res.body.offer.agreedPrice, 55000);
    assert.equal(notify.mock.calls[0].arguments[0].userId, FAMILY_ID);
  });

  test("le prestataire ne peut pas accepter son propre prix (409) ni une offre qui ne le concerne pas (404)", async () => {
    setup(fakeOffer({ applications: [application(P1)] }));
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/accept-proposal`, NANNY1)).status, 409);
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/accept-proposal`, NANNY2)).status, 404);
  });

  test("une offre avec accord ne peut plus être supprimée (400)", async () => {
    const offer = fakeOffer({ status: "closed", acceptedProvider: P1, applications: [application(P1, { status: "accepted" })], deleteOne: mock.fn(async () => {}) });
    setup(offer);
    assert.equal((await as("delete", `/api/offers/${OFFER_ID}`, FAMILY)).status, 400);
    assert.equal(offer.deleteOne.mock.callCount(), 0);
  });

  test("fermer une offre refuse et prévient les candidats en attente", async () => {
    const offer = fakeOffer({ applications: [application(P1), application(P2, { status: "rejected" })] });
    const notify = setup(offer);
    assert.equal((await as("put", `/api/offers/${OFFER_ID}/cancel`, FAMILY)).status, 200);
    assert.deepEqual(offer.applications.map((a) => a.status), ["rejected", "rejected"]);
    assert.equal(notify.mock.callCount(), 1);
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

  test("/my-applications : ni téléphone de la famille, ni candidatures des concurrents", async () => {
    const calls = {};
    const doc = fakeOffer({ family: { _id: FAMILY_ID, firstName: "Awa" }, applications: [application(P1), application(P2, { proposedPrice: 30000 })] });
    mock.method(Offer, "find", () => findChain([doc], calls));
    const res = await as("get", "/api/offers/my-applications", NANNY1);
    assert.equal(res.status, 200);
    assert.ok(!calls.populate.fields.includes("phone") && !calls.populate.fields.includes("email"));
    const o = res.body[0];
    assert.equal(o.applications, undefined);
    assert.equal(o.applicantsCount, 2);
    assert.equal(o.myApplication.proposedPrice, 50000);
    assert.equal(o.myApplication.turn, "family");
  });

  test("/available : même règle", async () => {
    const calls = {};
    mock.method(Offer, "find", () => findChain([fakeOffer({ applications: [application(P2)] })], calls));
    const res = await as("get", "/api/offers/available", NANNY1);
    assert.equal(res.status, 200);
    assert.ok(!calls.populate.fields.includes("phone"));
    assert.equal(res.body[0].applications, undefined);
    assert.equal(res.body[0].myApplication, null);
  });

  test("/my (famille) : ni téléphone ni email des prestataires, tours et compteurs calculés", async () => {
    const calls = {};
    mock.method(Offer, "find", () => findChain([fakeOffer({ applications: [application(P1)] })], calls));
    const res = await as("get", "/api/offers/my", FAMILY);
    assert.equal(res.status, 200);
    assert.ok(!/\bphone\b|\bemail\b|password/.test(calls.populate.fields));
    assert.equal(res.body[0].applications[0].turn, "family");
    assert.deepEqual(res.body[0].applications[0].countersLeft, { family: 3, provider: 3 });
  });
});

describe("Candidatures créées avant la négociation", () => {
  afterEach(() => mock.restoreAll());

  test("ancienne proposition directe sans historique : c'est au prestataire de répondre", async () => {
    const legacy = { provider: P1, status: "pending", lastOfferBy: "provider", history: [] };
    const offer = fakeOffer({ targetProvider: P1, price: 50000, applications: [legacy] });
    const notify = setup(offer);
    assert.equal((await as("post", `/api/offers/${OFFER_ID}/accept/${P1}`, FAMILY)).status, 409);
    const res = await as("post", `/api/offers/${OFFER_ID}/accept-proposal`, NANNY1);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(offer.agreedPrice, 50000);
    assert.ok(notify.mock.callCount() >= 1);
  });

  test("ancienne candidature à une offre publique : c'est à la famille de répondre", async () => {
    const offer = fakeOffer({ applications: [{ provider: P1, status: "pending", history: [] }] });
    setup(offer);
    const res = await as("post", `/api/offers/${OFFER_ID}/applications/${P1}/counter`, FAMILY, { amount: 45000 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(offer.applications[0].history.map((h) => h.by), ["provider", "family"]);
  });
});

describe("Ouverture du chat à l'accord", () => {
  afterEach(() => mock.restoreAll());

  test("l'accord ouvre le chat ISD avec un message d'accueil", async () => {
    const offer = fakeOffer({ applications: [application(P1)] });
    setup(offer);
    const create = mock.method(ChatSession, "create", async (d) => ({ ...d, _id: "chat" }));
    const welcome = mock.method(ChatMessage, "create", async (d) => d);
    const res = await as("post", `/api/offers/${OFFER_ID}/accept/${P1}`, FAMILY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(create.mock.callCount(), 1);
    assert.equal(String(create.mock.calls[0].arguments[0].providerId), P1);
    assert.equal(welcome.mock.calls[0].arguments[0].senderRole, "system");
  });
});
