const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const Offer = require("../models/Offer");
const Notification = require("../models/Notification");
const { tokenFor, buildApp } = require("./helpers");

const app = buildApp();
const OWNER_ID = "64b0000000000000000000a1";
const OTHER_FAMILY_ID = "64b0000000000000000000a2";
const OFFER_ID = "64b0000000000000000000b1";
const P1 = "64b0000000000000000000c1";
const P2 = "64b0000000000000000000c2";
const id = (s) => ({ toString: () => s });

const fakeOffer = (overrides = {}) => {
  const offer = {
    _id: OFFER_ID,
    family: id(OWNER_ID),
    status: "open",
    applications: [
      { provider: id(P1), status: "pending", proposedPrice: 50000, toObject() { return { provider: P1, status: this.status }; } },
      { provider: id(P2), status: "pending", proposedPrice: 45000, toObject() { return { provider: P2, status: this.status }; } },
    ],
    saved: false,
    async save() { this.saved = true; },
    ...overrides,
  };
  return offer;
};

describe("POST /api/offers/:offerId/reject/:providerId", () => {
  afterEach(() => mock.restoreAll());

  test("une autre famille ne peut pas refuser les candidats (403)", async () => {
    const offer = fakeOffer();
    mock.method(Offer, "findById", async () => offer);
    const notify = mock.method(Notification, "create", async () => ({}));
    const res = await request(app)
      .post(`/api/offers/${OFFER_ID}/reject/${P1}`)
      .set("Authorization", `Bearer ${tokenFor(OTHER_FAMILY_ID, "family")}`);
    assert.equal(res.status, 403);
    assert.equal(offer.applications[0].status, "pending");
    assert.equal(offer.saved, false);
    assert.equal(notify.mock.callCount(), 0);
  });

  test("un prestataire ne peut pas refuser (403)", async () => {
    mock.method(Offer, "findById", async () => fakeOffer());
    const res = await request(app)
      .post(`/api/offers/${OFFER_ID}/reject/${P1}`)
      .set("Authorization", `Bearer ${tokenFor(P2, "nanny")}`);
    assert.equal(res.status, 403);
  });

  test("la famille propriétaire refuse une candidature en attente (200)", async () => {
    const offer = fakeOffer();
    mock.method(Offer, "findById", async () => offer);
    mock.method(Notification, "create", async () => ({}));
    const res = await request(app)
      .post(`/api/offers/${OFFER_ID}/reject/${P1}`)
      .set("Authorization", `Bearer ${tokenFor(OWNER_ID, "family")}`);
    assert.equal(res.status, 200);
    assert.equal(offer.applications[0].status, "rejected");
    assert.equal(offer.applications[1].status, "pending");
    assert.equal(offer.saved, true);
  });

  test("identifiant malformé → 400 au lieu d'une erreur serveur", async () => {
    const res = await request(app)
      .post(`/api/offers/pas-un-id/reject/${P1}`)
      .set("Authorization", `Bearer ${tokenFor(OWNER_ID, "family")}`);
    assert.equal(res.status, 400);
  });
});

describe("POST /api/offers/:offerId/accept/:providerId", () => {
  afterEach(() => mock.restoreAll());

  test("refuse d'accepter quelqu'un qui n'a pas candidaté (404)", async () => {
    const offer = fakeOffer();
    mock.method(Offer, "findById", async () => offer);
    const notify = mock.method(Notification, "create", async () => ({}));
    const res = await request(app)
      .post(`/api/offers/${OFFER_ID}/accept/64b0000000000000000000ff`)
      .set("Authorization", `Bearer ${tokenFor(OWNER_ID, "family")}`);
    assert.equal(res.status, 404);
    assert.equal(offer.status, "open");
    assert.equal(notify.mock.callCount(), 0);
  });

  test("accepte un candidat et refuse automatiquement les autres (200)", async () => {
    const offer = fakeOffer();
    mock.method(Offer, "findById", async () => offer);
    mock.method(Notification, "create", async () => ({}));
    const res = await request(app)
      .post(`/api/offers/${OFFER_ID}/accept/${P1}`)
      .set("Authorization", `Bearer ${tokenFor(OWNER_ID, "family")}`);
    assert.equal(res.status, 200);
    assert.equal(offer.status, "closed");
    assert.deepEqual(offer.applications.map((a) => a.status), ["accepted", "rejected"]);
  });

  test("refuse un accord sans prix convenu (409)", async () => {
    const offer = fakeOffer();
    offer.applications[0].proposedPrice = null;
    mock.method(Offer, "findById", async () => offer);
    const notify = mock.method(Notification, "create", async () => ({}));
    const res = await request(app)
      .post(`/api/offers/${OFFER_ID}/accept/${P1}`)
      .set("Authorization", `Bearer ${tokenFor(OWNER_ID, "family")}`);
    assert.equal(res.status, 409);
    assert.match(res.body.message, /prix/);
    assert.equal(offer.status, "open");
    assert.equal(notify.mock.callCount(), 0);
  });

  test("une autre famille ne peut pas accepter (403)", async () => {
    mock.method(Offer, "findById", async () => fakeOffer());
    const res = await request(app)
      .post(`/api/offers/${OFFER_ID}/accept/${P1}`)
      .set("Authorization", `Bearer ${tokenFor(OTHER_FAMILY_ID, "family")}`);
    assert.equal(res.status, 403);
  });
});
