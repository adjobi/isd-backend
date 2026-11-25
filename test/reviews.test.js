const { test, describe, afterEach, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const Invoice = require("../models/Invoice");
const User = require("../models/User");
const MissionReview = require("../models/MissionReview");
const Notification = require("../models/Notification");
const AdminLog = require("../models/AdminLog");
const payment = require("../services/payment");
const reviews = require("../services/reviews");
const publicRoutes = require("../routes/publicRoutes");
const { tokenFor, buildApp } = require("./helpers");

const app = buildApp();
const FAMILY_ID = "64b0000000000000000000a1";
const PROVIDER_ID = "64b0000000000000000000c1";
const ADMIN_ID = "64b0000000000000000000e1";
const OFFER_ID = "64b0000000000000000000b1";
const FAMILY = tokenFor(FAMILY_ID, "family");
const NANNY = tokenFor(PROVIDER_ID, "nanny");
const ADMIN = tokenFor(ADMIN_ID, "family");
const DAY = 86400000;

const q = (doc) => {
  const o = { select: () => o, sort: () => o, limit: () => o, populate: () => o, lean: async () => doc };
  o.then = (res, rej) => Promise.resolve(doc).then(res, rej);
  return o;
};
const as = (method, url, token, body) => {
  const r = request(app)[method](url).set("Authorization", `Bearer ${token}`);
  return body ? r.send(body) : r;
};
const contract = (daysAgo, extra = {}) => ({
  _id: "64b0000000000000000000f9", offerId: OFFER_ID, family: FAMILY_ID, provider: PROVIDER_ID,
  terms: { startDate: new Date(Date.now() - daysAgo * DAY) },
  acceptedAt: { family: new Date(Date.now() - (daysAgo + 1) * DAY), provider: new Date(Date.now() - (daysAgo + 1) * DAY) },
  endedAt: null, ...extra,
});
const paidMission = (c) => {
  mock.method(Invoice, "findOne", async () => ({ _id: "i1", offerId: OFFER_ID, family: FAMILY_ID, provider: PROVIDER_ID, status: "paid" }));
  mock.method(payment, "ensureContract", async () => c);
};

describe("Avis : quand peut-on noter", () => {
  test("pas avant la confirmation des deux parties", () => {
    assert.equal(reviews.reviewOpensAt(contract(30, { acceptedAt: { family: new Date(), provider: null } })), null);
  });
  test("après 7 jours de mission, pas avant", () => {
    assert.equal(reviews.canReview(contract(3)), false);
    assert.equal(reviews.canReview(contract(8)), true);
  });
  test("dès la fin si la mission s'arrête plus tôt", () => {
    assert.equal(reviews.canReview(contract(2, { endedAt: new Date(Date.now() - DAY) })), true);
    // Préavis en cours (fin dans le futur) : il faut attendre la semaine ou la fin
    assert.equal(reviews.canReview(contract(2, { endedAt: new Date(Date.now() + 3 * DAY) })), false);
  });
  test("refuse une note hors 1 à 5 et les coordonnées dans le commentaire", () => {
    assert.ok(reviews.readReview({ rating: 6 }).errors.rating);
    assert.ok(reviews.readReview({ rating: 4.5 }).errors.rating);
    assert.ok(reviews.readReview({ rating: 5, comment: "Appelez-la au 07 01 02 03 04" }).errors.comment);
    assert.deepEqual(reviews.readReview({ rating: 5, comment: "  Très   ponctuelle. " }), { rating: 5, comment: "Très ponctuelle." });
  });
});

describe("Avis : donner son avis", () => {
  afterEach(() => mock.restoreAll());

  test("le prestataire ne peut pas se noter (403)", async () => {
    paidMission(contract(10));
    const res = await as("put", `/api/payments/${OFFER_ID}/review`, NANNY, { rating: 5 });
    assert.equal(res.status, 403);
  });

  test("trop tôt : 409", async () => {
    paidMission(contract(2));
    const res = await as("put", `/api/payments/${OFFER_ID}/review`, FAMILY, { rating: 5 });
    assert.equal(res.status, 409);
  });

  test("avis enregistré, note du profil recalculée, prestataire prévenu", async () => {
    paidMission(contract(10));
    mock.method(MissionReview, "findOne", async () => null);
    mock.method(User, "findById", () => q({ role: "nanny", serviceType: "nanny" }));
    const saved = mock.method(MissionReview.prototype, "save", async function () { return this; });
    mock.method(MissionReview, "aggregate", async () => [{ avg: 4.666, n: 3 }]);
    const upd = mock.method(User, "updateOne", async () => ({}));
    const notif = mock.method(Notification, "create", async () => ({}));
    const res = await as("put", `/api/payments/${OFFER_ID}/review`, FAMILY, { rating: 5, comment: "Très douce avec les enfants." });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(saved.mock.callCount(), 1);
    assert.deepEqual(upd.mock.calls[0].arguments[1], { $set: { rating: 4.7, reviewCount: 3 } });
    assert.equal(String(notif.mock.calls[0].arguments[0].userId), PROVIDER_ID);
  });

  test("avis masqué par ISD : plus modifiable", async () => {
    paidMission(contract(10));
    mock.method(MissionReview, "findOne", async () => ({ status: "hidden" }));
    const res = await as("put", `/api/payments/${OFFER_ID}/review`, FAMILY, { rating: 1 });
    assert.equal(res.status, 409);
  });
});

describe("Avis : modération ISD", () => {
  afterEach(() => mock.restoreAll());
  const admin = () => mock.method(User, "findById", (id) => q({ _id: id, isAdmin: String(id) === ADMIN_ID }));

  test("masquer : motif obligatoire, note recalculée, journal", async () => {
    admin();
    const review = { _id: "r1", family: FAMILY_ID, provider: PROVIDER_ID, rating: 1, status: "published", async save() {} };
    mock.method(MissionReview, "findById", async () => review);
    mock.method(MissionReview, "aggregate", async () => []);
    const upd = mock.method(User, "updateOne", async () => ({}));
    const log = mock.method(AdminLog, "create", async () => ({}));
    const url = "/api/admin/reviews/64b0000000000000000000aa/hide";
    assert.equal((await as("post", url, ADMIN, { note: "" })).status, 400);
    const res = await as("post", url, ADMIN, { note: "Propos injurieux" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(review.status, "hidden");
    assert.deepEqual(upd.mock.calls[0].arguments[1], { $set: { rating: 0, reviewCount: 0 } });
    assert.equal(log.mock.calls[0].arguments[0].action, "review_hidden");
  });

  test("un administrateur concerné ne peut pas modérer l'avis", async () => {
    admin();
    mock.method(MissionReview, "findById", async () => ({ family: ADMIN_ID, provider: PROVIDER_ID, status: "published" }));
    const res = await as("post", "/api/admin/reviews/64b0000000000000000000aa/hide", ADMIN, { note: "Propos injurieux" });
    assert.equal(res.status, 403);
  });
});

describe("Vitrine : photo et avis publics", () => {
  beforeEach(() => { publicRoutes.clearCache(); publicRoutes.publicLimiter.reset(); });
  afterEach(() => mock.restoreAll());
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  test("photo servie seulement avec l'accord du prestataire", async () => {
    let filter;
    mock.method(User, "findOne", (f) => { filter = f; return q(f.photoPublic ? { photo: `data:image/png;base64,${PNG}` } : null); });
    const res = await request(app).get(`/api/public/providers/${PROVIDER_ID}/photo`);
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "image/png");
    assert.equal(filter.photoPublic, true);
    assert.deepEqual(filter.role, { $in: ["nanny", "tutor"] });
    assert.equal((await request(app).get("/api/public/providers/pas-un-id/photo")).status, 404);
  });

  test("profil : adresse de photo seulement si accord", async () => {
    const base = { _id: PROVIDER_ID, role: "nanny", firstName: "Awa", lastName: "Koné", photo: "data:image/png;base64,AAAA", photoUpdatedAt: new Date() };
    mock.method(User, "find", () => q([base, { ...base, photoPublic: true }]));
    mock.method(User, "countDocuments", async () => 2);
    const res = await request(app).get("/api/public/providers");
    const [without, withPhoto] = res.body.providers;
    assert.equal(without.photo, null);
    assert.match(withPhoto.photo, new RegExp(`^/api/public/providers/${PROVIDER_ID}/photo\\?v=`));
    assert.ok(!JSON.stringify(res.body).includes("base64"));
  });

  test("avis publics : prénom et initiale seulement", async () => {
    mock.method(MissionReview, "find", () => q([{
      rating: 5, comment: "Parfaite", serviceType: "nanny", createdAt: new Date(),
      family: { firstName: "Marie Claire", lastName: "yao", phone: "0701020304" },
      provider: { firstName: "Awa", lastName: "Koné", commune: "Cocody" },
    }]));
    mock.method(MissionReview, "aggregate", async () => [{ avg: 4.84, n: 7 }]);
    const res = await request(app).get("/api/public/reviews");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.reviews[0].family, "Marie Y.");
    assert.equal(res.body.reviews[0].provider, "Awa K.");
    assert.equal(res.body.average, 4.8);
    assert.equal(res.body.total, 7);
    assert.ok(!JSON.stringify(res.body).includes("0701020304"));
  });
});
