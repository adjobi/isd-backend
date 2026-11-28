const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const Invoice = require("../models/Invoice");
const Contract = require("../models/Contract");
const Offer = require("../models/Offer");
const User = require("../models/User");
const Report = require("../models/Report");
const AdminLog = require("../models/AdminLog");
const Notification = require("../models/Notification");
const { ChatSession, ChatMessage } = require("../models/Chat");
const E = require("../services/engagement");
const { tokenFor, buildApp } = require("./helpers");

const app = buildApp();
const DAY = 86400000;
const FAMILY_ID = "64b0000000000000000000a1";
const PROVIDER_ID = "64b0000000000000000000c1";
const ADMIN_ID = "64b0000000000000000000e1";
const OFFER_ID = "64b0000000000000000000b1";
const REPORT_ID = "64b0000000000000000000f9";
const FAMILY = tokenFor(FAMILY_ID, "family");
const NANNY = tokenFor(PROVIDER_ID, "nanny");
const ADMIN = tokenFor(ADMIN_ID, "family");

const as = (method, url, token, body) => {
  const r = request(app)[method](url).set("Authorization", `Bearer ${token}`);
  return body ? r.send(body) : r;
};
const q = (doc) => {
  const o = { select: () => o, sort: () => o, limit: () => o, populate: () => o, lean: async () => doc };
  o.then = (res, rej) => Promise.resolve(doc).then(res, rej);
  return o;
};
const active = (extra = {}) => ({
  _id: "c1", terms: { noticeDays: 15 }, acceptedAt: { family: new Date(), provider: new Date() },
  endedAt: null, termination: null, saves: 0, markModified() {}, async save() { this.saves += 1; }, ...extra,
});
const paidInvoice = (extra = {}) => ({
  _id: "i1", offerId: OFFER_ID, family: FAMILY_ID, provider: PROVIDER_ID, status: "paid",
  guaranteeUntil: new Date(Date.now() + 10 * DAY), guaranteeUsedAt: null, ...extra,
});
// Contexte d'une mission réglée : facture, récapitulatif, chat et notifications simulés.
const mission = (contract, invoice = paidInvoice()) => {
  mock.method(Invoice, "findOne", async () => invoice);
  mock.method(Contract, "findOne", async () => contract);
  const session = { offerId: OFFER_ID, familyId: FAMILY_ID, providerId: PROVIDER_ID, status: "paid", async save() {} };
  mock.method(ChatSession, "findOne", async () => session);
  const msgs = mock.method(ChatMessage, "create", async (d) => d);
  const notifs = mock.method(Notification, "create", async () => ({}));
  return { session, msgs, notifs };
};

describe("Engagements : préavis convenu à deux", () => {
  test("la première partie choisit, l'autre confirme : engagements en vigueur", () => {
    const c = { terms: {}, acceptedAt: { family: null, provider: null } };
    assert.equal(E.applyAccept(c, "family", undefined).status, 400);
    const r1 = E.applyAccept(c, "family", 15);
    assert.deepEqual([r1.changed, r1.proposed, r1.active], [true, false, false]);
    const r2 = E.applyAccept(c, "provider", undefined);
    assert.deepEqual([r2.changed, r2.active], [false, true]);
    assert.equal(E.stateOf(c), "active");
    assert.equal(E.applyAccept(c, "family", 30).status, 409);
  });

  test("proposer une autre durée annule la confirmation de l'autre partie", () => {
    const c = { terms: { noticeDays: 15, noticeSetBy: "family" }, acceptedAt: { family: new Date(), provider: null } };
    const r = E.applyAccept(c, "provider", 7);
    assert.deepEqual([r.changed, r.proposed, r.active], [true, true, false]);
    assert.equal(c.acceptedAt.family, null);
    assert.equal(c.terms.noticeSetBy, "provider");
    assert.equal(E.applyAccept(c, "family", 7).active, true);
  });

  test("ancien récapitulatif confirmé sans préavis choisi : 7 jours", () => {
    const c = { terms: {}, acceptedAt: { family: new Date(), provider: null } };
    const r = E.applyAccept(c, "provider", undefined);
    assert.equal(r.active, true);
    assert.equal(c.terms.noticeDays, 7);
    assert.equal(E.noticeDaysOf({ terms: {}, acceptedAt: { family: new Date(), provider: new Date() } }), 7);
  });

  test("durée invalide refusée", () => {
    const c = { terms: {}, acceptedAt: {} };
    assert.equal(E.applyAccept(c, "family", 120).status, 400);
    assert.equal(E.applyAccept(c, "family", 2.5).status, 400);
    assert.equal(E.applyAccept(c, "family", -1).status, 400);
  });
});

describe("Engagements : fin de mission", () => {
  const now = new Date("2026-11-24T10:00:00Z");

  test("avec préavis : fin programmée après le nombre de jours convenu", () => {
    const r = E.planEnd(active(), "provider", { mode: "notice", reason: "personal" }, now);
    assert.equal(r.termination.status, "notified");
    assert.equal(r.termination.noticeDays, 15);
    assert.ok(r.termination.effectiveAt - now > 14 * DAY);
    assert.equal(r.endNow, false);
  });

  test("engagements non confirmés par les deux : pas de préavis, fin immédiate", () => {
    const r = E.planEnd(active({ acceptedAt: { family: new Date(), provider: null } }), "family", { mode: "notice", reason: "need_over" }, now);
    assert.equal(r.termination.noticeDays, 0);
    assert.equal(r.endNow, true);
  });

  test("commun accord : date proposée, l'autre partie répond", () => {
    const c = active();
    const r = E.planEnd(c, "family", { mode: "mutual", reason: "moving", date: new Date(now.getTime() + 5 * DAY) }, now);
    assert.equal(r.termination.status, "proposed");
    c.termination = r.termination;
    assert.equal(E.planEnd(c, "provider", { mode: "notice", reason: "personal" }, now).status, 409);
    assert.equal(E.applyEndResponse(c, "family", true, now).status, 403);
    const ok = E.applyEndResponse(c, "provider", true, now);
    assert.equal(ok.termination.status, "accepted");
    assert.ok(ok.endedAt > now);
    const no = E.applyEndResponse(c, "provider", false, now);
    assert.equal(no.endedAt, null);
  });

  test("motif, date et précisions vérifiés", () => {
    assert.equal(E.planEnd(active(), "family", { mode: "notice", reason: "payment" }, now).field, "reason");
    assert.equal(E.planEnd(active(), "family", { mode: "nope", reason: "moving" }, now).field, "mode");
    assert.equal(E.planEnd(active(), "family", { mode: "mutual", reason: "moving", date: "2020-01-01" }, now).field, "date");
    assert.equal(E.planEnd(active(), "family", { mode: "mutual", reason: "moving", date: new Date(now.getTime() + 200 * DAY) }, now).field, "date");
    assert.equal(E.planEnd(active(), "family", { mode: "serious", reason: "behaviour", comment: "trop court" }, now).field, "comment");
  });

  test("mission terminée ou en préavis : pas de nouvelle demande", () => {
    assert.equal(E.planEnd(active({ endedAt: new Date(now.getTime() - DAY) }), "family", { mode: "notice", reason: "moving" }, now).status, 409);
    assert.equal(E.planEnd(active({ endedAt: new Date(now.getTime() + DAY) }), "family", { mode: "notice", reason: "moving" }, now).status, 409);
  });

  test("garantie : le prestataire parti pendant la garantie laisse le remplacement ouvert", () => {
    const inv = paidInvoice({ guaranteeUntil: new Date(now.getTime() - DAY) });
    assert.equal(E.replacementAllowed(inv, active(), now), false);
    const left = active({ termination: { by: "provider", status: "notified", requestedAt: new Date(now.getTime() - 3 * DAY) } });
    assert.equal(E.replacementAllowed(inv, left, now), true);
    const famLeft = active({ termination: { by: "family", status: "notified", requestedAt: new Date(now.getTime() - 3 * DAY) } });
    assert.equal(E.replacementAllowed(inv, famLeft, now), false);
  });
});

describe("Routes de fin de mission", () => {
  afterEach(() => mock.restoreAll());

  test("préavis : fin programmée, autre partie prévenue, message ISD", async () => {
    const c = active();
    const { msgs, notifs } = mission(c);
    const res = await as("post", `/api/payments/${OFFER_ID}/contract/end`, NANNY, { mode: "notice", reason: "personal" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.contract.state, "ending");
    assert.equal(c.endReason, "notice");
    assert.equal(c.endedBy, "provider");
    assert.equal(String(notifs.mock.calls[0].arguments[0].userId), FAMILY_ID);
    assert.match(msgs.mock.calls[0].arguments[0].message, /préavis convenu de 15 jours/);
  });

  test("faute grave : fin immédiate, chat fermé, signalement à ISD", async () => {
    const c = active();
    const { session } = mission(c);
    const reports = mock.method(Report, "create", async (d) => d);
    const res = await as("post", `/api/payments/${OFFER_ID}/contract/end`, FAMILY, { mode: "serious", reason: "behaviour", comment: "Absences répétées sans prévenir depuis deux semaines" });
    assert.equal(res.status, 201);
    assert.equal(res.body.contract.state, "ended");
    assert.equal(session.status, "closed");
    assert.equal(String(reports.mock.calls[0].arguments[0].against), PROVIDER_ID);
  });

  test("pas de coordonnées dans les précisions", async () => {
    mission(active());
    const res = await as("post", `/api/payments/${OFFER_ID}/contract/end`, FAMILY, { mode: "notice", reason: "other", comment: "Appelez-moi au 07 01 02 03 04 pour en parler" });
    assert.equal(res.status, 400);
  });

  test("commun accord : réponse de l'autre partie, retrait par l'auteur", async () => {
    const c = active({ termination: { mode: "mutual", by: "family", reason: "moving", status: "proposed", requestedAt: new Date(), effectiveAt: new Date(Date.now() + 5 * DAY) } });
    mission(c);
    assert.equal((await as("post", `/api/payments/${OFFER_ID}/contract/end/respond`, FAMILY, { accept: true })).status, 403);
    assert.equal((await as("post", `/api/payments/${OFFER_ID}/contract/end/cancel`, NANNY)).status, 403);
    const res = await as("post", `/api/payments/${OFFER_ID}/contract/end/respond`, NANNY, { accept: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.contract.state, "ending");
    assert.equal(c.endReason, "mutual");
    assert.equal(c.endedBy, "family");
  });

  test("le prestataire parti pendant la garantie : remplacement possible après sa fin", async () => {
    const c = active({ endedAt: new Date(Date.now() - DAY), termination: { by: "provider", status: "notified", requestedAt: new Date(Date.now() - 20 * DAY) } });
    mission(c, paidInvoice({ guaranteeUntil: new Date(Date.now() - 5 * DAY), async save() {} }));
    mock.method(Offer, "findById", async () => ({ _id: OFFER_ID, family: FAMILY_ID, serviceType: "nanny", description: "Garde", duration: "long", agreedPrice: 60000, city: "Abidjan" }));
    mock.method(Offer, "create", async (d) => ({ _id: "nouvelle", ...d }));
    const res = await as("post", `/api/payments/${OFFER_ID}/replacement`, FAMILY, { reason: "La nounou est partie, il nous faut quelqu'un" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(c.saves, 0); // la date de fin convenue n'est pas modifiée
  });
});

describe("Actions en attente", () => {
  afterEach(() => mock.restoreAll());

  test("famille : candidatures, facture, préavis proposé, fin proposée", async () => {
    const offer = { _id: OFFER_ID, description: "Garde à Cocody", updatedAt: new Date(), applications: [
      { provider: "64b0000000000000000000c9", status: "pending", stage: "applied" },
      // Discussion en cours : la famille a confirmé la mission, c'est au prestataire (pas d'action pour elle)
      { provider: PROVIDER_ID, status: "pending", stage: "discussion", sessionId: "s1", missionAgreed: { family: new Date(), provider: null } },
    ] };
    mock.method(Offer, "find", (filter) => q(filter._id ? [offer] : [offer]));
    mock.method(ChatSession, "find", () => q([]));
    mock.method(Invoice, "find", () => q([{ offerId: OFFER_ID, status: "rejected", updatedAt: new Date() }]));
    mock.method(Contract, "find", () => q([{
      offerId: OFFER_ID, family: FAMILY_ID, provider: PROVIDER_ID, endedAt: null, updatedAt: new Date(),
      acceptedAt: { family: null, provider: new Date() }, terms: { noticeDays: 30, noticeSetBy: "provider" },
      termination: { status: "proposed", by: "provider", requestedAt: new Date(), effectiveAt: new Date(Date.now() + 3 * DAY) },
    }]));
    mock.method(User, "find", () => q([{ _id: PROVIDER_ID, firstName: "Awa", lastName: "Koné" }]));
    const res = await as("get", "/api/actions", FAMILY);
    assert.equal(res.status, 200);
    const kinds = res.body.actions.map((a) => a.kind);
    assert.deepEqual(kinds, ["end_response", "payment_rejected", "notice_confirm", "applications"]);
    assert.match(res.body.actions[0].title, /Awa K\./);
    assert.match(res.body.actions[3].title, /^1 candidature/);
  });

  test("prestataire : contre-proposition de la famille et date proposée", async () => {
    mock.method(Offer, "find", (filter) => q(filter._id ? [{ _id: OFFER_ID, description: "Cours de maths" }] : [{
      _id: OFFER_ID, description: "Cours de maths", family: FAMILY_ID, updatedAt: new Date(),
      applications: [{ provider: PROVIDER_ID, status: "pending", stage: "salary", sessionId: "s1", history: [{ by: "family", amount: 40000 }], lastOfferBy: "family" }],
    }]));
    mock.method(ChatSession, "find", () => q([{ offerId: OFFER_ID, familyId: FAMILY_ID, providerId: PROVIDER_ID, startDateProposal: { date: new Date(), by: "family", at: new Date() } }]));
    mock.method(Contract, "find", () => q([]));
    mock.method(User, "find", () => q([{ _id: FAMILY_ID, firstName: "Marie", lastName: "Yao" }]));
    // Identité déjà vérifiée : pas d'action « identity » (voir test/identity.test.js)
    mock.method(User, "findById", () => q({ _id: PROVIDER_ID, role: "nanny", isVerified: true }));
    mock.method(require("../models/IdentityCheck"), "findOne", () => q(null));
    const res = await as("get", "/api/actions", NANNY);
    assert.deepEqual(res.body.actions.map((a) => a.kind), ["counter_offer", "start_date_reply"]);
    assert.equal(res.body.actions[0].route, "Chat");
    assert.equal(res.body.actions[0].params.sessionId, "s1");
    assert.equal(res.body.actions[1].route, "Chat");
  });

  test("discussions : confirmer la mission, proposer le salaire (une action par discussion)", async () => {
    const P2 = "64b0000000000000000000c8";
    mock.method(Offer, "find", (filter) => q(filter._id ? [] : [{
      _id: OFFER_ID, description: "Garde à Cocody", updatedAt: new Date(), applications: [
        { provider: PROVIDER_ID, status: "pending", stage: "discussion", sessionId: "s1", missionAgreed: { family: null, provider: new Date() } },
        { provider: P2, status: "pending", stage: "salary", sessionId: "s2", missionAgreed: { family: new Date(), provider: new Date() }, history: [] },
      ],
    }]));
    let sessionFilter;
    mock.method(ChatSession, "find", (f) => { sessionFilter = f; return q([]); });
    mock.method(Invoice, "find", () => q([]));
    mock.method(Contract, "find", () => q([]));
    mock.method(User, "find", () => q([{ _id: PROVIDER_ID, firstName: "Awa", lastName: "Koné" }]));
    const res = await as("get", "/api/actions", FAMILY);
    assert.deepEqual(res.body.actions.map((a) => a.kind).sort(), ["mission_confirm", "salary_propose"]);
    const m = res.body.actions.find((a) => a.kind === "mission_confirm");
    assert.match(m.title, /Awa K\. est d'accord/);
    assert.deepEqual(m.params, { offerId: OFFER_ID, providerId: PROVIDER_ID, sessionId: "s1" });
    assert.notEqual(res.body.actions[0].id, res.body.actions[1].id);
    // La date de début ne concerne que la discussion de l'accord
    assert.deepEqual(sessionFilter.status, { $nin: ["closed", "discussion"] });
  });

  test("rien en attente : liste vide", async () => {
    mock.method(Offer, "find", () => q([]));
    mock.method(ChatSession, "find", () => q([]));
    mock.method(Invoice, "find", () => q([]));
    mock.method(Contract, "find", () => q([]));
    const res = await as("get", "/api/actions", FAMILY);
    assert.deepEqual(res.body.actions, []);
  });
});

describe("Signalements dans l'Espace ISD", () => {
  afterEach(() => mock.restoreAll());
  const admin = () => mock.method(User, "findById", (id) => q({ _id: id, isAdmin: String(id) === ADMIN_ID }));

  test("traitement journalisé ; jamais par une personne concernée", async () => {
    admin();
    const report = { _id: REPORT_ID, by: FAMILY_ID, against: PROVIDER_ID, status: "open", async save() {} };
    mock.method(Report, "findById", async () => report);
    const logs = mock.method(AdminLog, "create", async () => ({}));
    assert.equal((await as("post", `/api/admin/reports/${REPORT_ID}/handle`, ADMIN, { note: "court" })).status, 400);
    const res = await as("post", `/api/admin/reports/${REPORT_ID}/handle`, ADMIN, { note: "Appel aux deux parties, médiation proposée" });
    assert.equal(res.status, 200);
    assert.equal(report.status, "handled");
    assert.equal(logs.mock.calls[0].arguments[0].action, "report_handled");
    assert.equal((await as("post", `/api/admin/reports/${REPORT_ID}/handle`, ADMIN, { note: "Appel aux deux parties, médiation proposée" })).status, 409);
  });
});
