const { test, describe, afterEach, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const Invoice = require("../models/Invoice");
const Contract = require("../models/Contract");
const Offer = require("../models/Offer");
const User = require("../models/User");
const Setting = require("../models/Setting");
const AdminLog = require("../models/AdminLog");
const Notification = require("../models/Notification");
const { ChatSession, ChatMessage } = require("../models/Chat");
const { computeFee, validatePricing, DEFAULT_PRICING } = require("../services/pricing");
const payment = require("../services/payment");
const { tokenFor, buildApp } = require("./helpers");

const app = buildApp();
const FAMILY_ID = "64b0000000000000000000a1";
const PROVIDER_ID = "64b0000000000000000000c1";
const ADMIN_ID = "64b0000000000000000000e1";
const OUTSIDER_ID = "64b0000000000000000000d1";
const OFFER_ID = "64b0000000000000000000b1";
const INVOICE_ID = "64b0000000000000000000f1";
const FAMILY = tokenFor(FAMILY_ID, "family");
const NANNY = tokenFor(PROVIDER_ID, "nanny");
const ADMIN = tokenFor(ADMIN_ID, "family");
const OUTSIDER = tokenFor(OUTSIDER_ID, "family");

const q = (doc) => {
  const o = { select: () => o, sort: () => o, limit: () => o, lean: async () => doc };
  o.then = (res, rej) => Promise.resolve(doc).then(res, rej);
  return o;
};
const fakeInvoice = (extra = {}) => ({
  _id: INVOICE_ID, offerId: OFFER_ID, family: FAMILY_ID, provider: PROVIDER_ID, reference: "ISD-ABC234",
  amount: 12000, currency: "XOF", status: "pending", breakdown: { kind: "percent" }, declaration: {}, declarationCount: 0,
  gateway: {}, startDate: new Date(Date.now() + 7 * 86400000),
  saves: 0, async save() { this.saves += 1; }, ...extra,
});
const as = (method, url, token, body) => {
  const r = request(app)[method](url).set("Authorization", `Bearer ${token}`);
  return body ? r.send(body) : r;
};
// Utilisateurs : seul ADMIN est administrateur.
const users = (extra = {}) => mock.method(User, "findById", (id) => q({ _id: id, isAdmin: String(id) === ADMIN_ID, firstName: "Prénom", lastName: "Nom", phone: "0701020304", email: "x@y.ci", ...extra[String(id)] }));
// Effets de markPaid simulés.
const paidEffects = () => {
  users();
  mock.method(Setting, "findOne", () => q(null));
  mock.method(Offer, "findById", async () => ({ _id: OFFER_ID, agreedPrice: 60000, serviceType: "nanny", async save() {} }));
  mock.method(Contract, "findOne", async () => null);
  const contract = mock.method(Contract, "create", async (d) => d);
  const session = { offerId: OFFER_ID, familyId: FAMILY_ID, providerId: PROVIDER_ID, status: "agreement_reached", async save() {} };
  mock.method(ChatSession, "findOne", async () => session);
  mock.method(ChatMessage, "create", async (d) => d);
  const notifs = mock.method(Notification, "create", async () => ({}));
  return { contract, session, notifs };
};

describe("Calcul des frais", () => {
  const P = { ...DEFAULT_PRICING, launchUntil: null };
  test("20 % du premier mois, arrondi à la centaine", () => {
    assert.equal(computeFee({ agreedPrice: 60000, unit: "month", duration: "long" }, P).amount, 12000);
    assert.equal(computeFee({ agreedPrice: 45500, unit: "month", duration: "long" }, P).amount, 9100);
  });
  test("estimation mensuelle selon l'unité, minimum appliqué", () => {
    assert.equal(computeFee({ agreedPrice: 5000, unit: "session", duration: "long" }, P).amount, 8000);
    assert.equal(computeFee({ agreedPrice: 3000, unit: "hour", duration: "long" }, P).amount, 9600);
    assert.equal(computeFee({ agreedPrice: 10000, unit: "month", duration: "long" }, P).amount, 3000);
  });
  test("forfait courte durée, offre de lancement, remplacement offert", () => {
    assert.equal(computeFee({ agreedPrice: 60000, unit: "month", duration: "short" }, P).amount, 3000);
    const launch = computeFee({ agreedPrice: 60000, unit: "month", duration: "long" }, { ...P, launchUntil: "2099-12-31" });
    assert.equal(launch.amount, 6000);
    assert.equal(launch.discount, 6000);
    assert.equal(computeFee({ agreedPrice: 60000, unit: "month", duration: "long", waived: true }, P).amount, 0);
  });
  test("réglages administrateur validés", () => {
    assert.ok(validatePricing({ ratePercent: 80, minFee: 1, shortFlat: 1, launchDiscountPercent: 0, guaranteeDays: 30, launchUntil: null }).errors.ratePercent);
    const ok = validatePricing({ ratePercent: 20, minFee: 3000, shortFlat: 3000, launchDiscountPercent: 50, guaranteeDays: 30, launchUntil: "2027-02-28" });
    assert.equal(ok.value.rate, 0.2);
    assert.equal(ok.value.launchDiscount, 0.5);
  });
});

describe("Facture et paiement manuel", () => {
  afterEach(() => mock.restoreAll());

  test("un compte extérieur ne voit pas la facture (404)", async () => {
    mock.method(Invoice, "findOne", async () => fakeInvoice());
    assert.equal((await as("get", `/api/payments/${OFFER_ID}`, OUTSIDER)).status, 404);
  });

  test("la famille voit sa déclaration, le prestataire seulement le statut", async () => {
    mock.method(Invoice, "findOne", async () => fakeInvoice({ declaration: { operator: "wave", transactionRef: "ABC123" } }));
    const fam = await as("get", `/api/payments/${OFFER_ID}`, FAMILY);
    assert.equal(fam.status, 200);
    assert.equal(fam.body.invoice.declaration.transactionRef, "ABC123");
    const prov = await as("get", `/api/payments/${OFFER_ID}`, NANNY);
    assert.equal(prov.body.invoice.declaration, undefined);
    assert.equal(prov.body.role, "provider");
  });

  test("déclaration : réservée à la famille, champs validés", async () => {
    mock.method(Invoice, "findOne", async () => fakeInvoice());
    assert.equal((await as("post", `/api/payments/${OFFER_ID}/declare`, NANNY, { operator: "wave", transactionRef: "ABC123" })).status, 403);
    const bad = await as("post", `/api/payments/${OFFER_ID}/declare`, FAMILY, { operator: "paypal", transactionRef: "x" });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.errors.operator && bad.body.errors.transactionRef);
  });

  test("déclaration valide : en vérification, administrateurs prévenus ; pas de double déclaration", async () => {
    const invoice = fakeInvoice();
    mock.method(Invoice, "findOne", async (f) => (f._id ? null : invoice));
    mock.method(User, "find", () => q([{ _id: ADMIN_ID }]));
    const notifs = mock.method(Notification, "create", async () => ({}));
    const res = await as("post", `/api/payments/${OFFER_ID}/declare`, FAMILY, { operator: "wave", transactionRef: " tx-98ab12 " });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(invoice.status, "submitted");
    assert.equal(invoice.declaration.transactionRef, "TX-98AB12");
    assert.equal(String(notifs.mock.calls[0].arguments[0].userId), ADMIN_ID);
    assert.equal((await as("post", `/api/payments/${OFFER_ID}/declare`, FAMILY, { operator: "wave", transactionRef: "TX2" + "000" })).status, 409);
  });

  test("identifiant de transaction déjà utilisé (409), trop de déclarations (429)", async () => {
    mock.method(Invoice, "findOne", async (f) => (f._id ? { _id: "autre" } : fakeInvoice()));
    assert.equal((await as("post", `/api/payments/${OFFER_ID}/declare`, FAMILY, { operator: "orange", transactionRef: "OM12345" })).status, 409);
    mock.method(Invoice, "findOne", async () => fakeInvoice({ status: "rejected", declarationCount: 5 }));
    assert.equal((await as("post", `/api/payments/${OFFER_ID}/declare`, FAMILY, { operator: "orange", transactionRef: "OM12345" })).status, 429);
  });

  test("coordonnées et contrat refusés avant paiement (403)", async () => {
    mock.method(Invoice, "findOne", async () => fakeInvoice({ status: "submitted" }));
    assert.equal((await as("get", `/api/payments/${OFFER_ID}/contacts`, FAMILY)).status, 403);
    assert.equal((await as("get", `/api/payments/${OFFER_ID}/contract`, NANNY)).status, 403);
  });

  test("après paiement : chacun reçoit les coordonnées de l'autre", async () => {
    mock.method(Invoice, "findOne", async () => fakeInvoice({ status: "paid" }));
    const find = users({ [PROVIDER_ID]: { phone: "0709102524" } });
    const res = await as("get", `/api/payments/${OFFER_ID}/contacts`, FAMILY);
    assert.equal(res.status, 200);
    assert.equal(res.body.contact.phone, "0709102524");
    assert.equal(String(find.mock.calls[0].arguments[0]), PROVIDER_ID);
    await as("get", `/api/payments/${OFFER_ID}/contacts`, NANNY);
    assert.equal(String(find.mock.calls[1].arguments[0]), FAMILY_ID);
  });

  test("paiement automatique non configuré (503)", async () => {
    mock.method(Invoice, "findOne", async () => fakeInvoice());
    assert.equal((await as("post", `/api/payments/${OFFER_ID}/checkout`, FAMILY)).status, 503);
  });
});

describe("Validation par un administrateur", () => {
  afterEach(() => mock.restoreAll());

  test("contrat absent après paiement : recréé à la consultation", async () => {
    mock.method(Invoice, "findOne", async () => fakeInvoice({ status: "paid", breakdown: { unit: "month" } }));
    mock.method(Contract, "findOne", async () => null);
    mock.method(Offer, "findById", async () => ({ agreedPrice: 60000, serviceType: "nanny" }));
    users();
    const create = mock.method(Contract, "create", async (d) => ({ ...d, acceptedAt: {} }));
    const res = await as("get", `/api/payments/${OFFER_ID}/contract`, FAMILY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(create.mock.callCount(), 1);
    assert.equal(res.body.contract.terms.agreedPrice, 60000);
  });

  test("non-administrateur refusé (403)", async () => {
    users();
    assert.equal((await as("get", "/api/admin/payments", FAMILY)).status, 403);
    assert.equal((await as("post", `/api/admin/payments/${INVOICE_ID}/confirm`, FAMILY)).status, 403);
  });

  test("confirmer : facture réglée, contrat créé, chat débloqué, parties prévenues", async () => {
    const logs = mock.method(AdminLog, "create", async (d) => d);
    users();
    const invoice = fakeInvoice({ status: "submitted" });
    mock.method(Invoice, "findById", async () => invoice);
    const { contract, session, notifs } = paidEffects();
    const res = await as("post", `/api/admin/payments/${INVOICE_ID}/confirm`, ADMIN);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(invoice.status, "paid");
    assert.equal(String(invoice.verifiedBy), ADMIN_ID);
    assert.ok(invoice.guaranteeUntil > invoice.startDate);
    assert.equal(contract.mock.callCount(), 1);
    assert.equal(session.isPaid, true);
    assert.equal(notifs.mock.callCount(), 2);
    assert.equal(logs.mock.callCount(), 1);
    assert.equal(logs.mock.calls[0].arguments[0].action, "payment_confirmed");
    assert.equal(String(logs.mock.calls[0].arguments[0].admin), ADMIN_ID);
    assert.equal((await as("post", `/api/admin/payments/${INVOICE_ID}/confirm`, ADMIN)).status, 409);
    assert.equal(logs.mock.callCount(), 1);
  });

  test("un administrateur ne valide pas une facture qui le concerne (403)", async () => {
    users();
    mock.method(Invoice, "findById", async () => fakeInvoice({ status: "submitted", family: ADMIN_ID }));
    assert.equal((await as("post", `/api/admin/payments/${INVOICE_ID}/confirm`, ADMIN)).status, 403);
  });

  test("refuser : motif obligatoire, famille prévenue", async () => {
    const logs = mock.method(AdminLog, "create", async (d) => d);
    users();
    const invoice = fakeInvoice({ status: "submitted" });
    mock.method(Invoice, "findById", async () => invoice);
    const notifs = mock.method(Notification, "create", async () => ({}));
    assert.equal((await as("post", `/api/admin/payments/${INVOICE_ID}/reject`, ADMIN, { reason: "" })).status, 400);
    const res = await as("post", `/api/admin/payments/${INVOICE_ID}/reject`, ADMIN, { reason: "Transaction introuvable sur le compte Wave" });
    assert.equal(res.status, 200);
    assert.equal(invoice.status, "rejected");
    assert.equal(String(notifs.mock.calls[0].arguments[0].userId), FAMILY_ID);
    assert.equal(logs.mock.calls[0].arguments[0].action, "payment_rejected");
    assert.equal(logs.mock.calls[0].arguments[0].details.reason, "Transaction introuvable sur le compte Wave");
  });

  test("tarifs : lecture et mise à jour validée", async () => {
    const logs = mock.method(AdminLog, "create", async (d) => d);
    users();
    mock.method(Setting, "findOne", () => q(null));
    const res = await as("get", "/api/admin/settings/pricing", ADMIN);
    assert.equal(res.body.ratePercent, 20);
    const upsert = mock.method(Setting, "findOneAndUpdate", async () => ({}));
    assert.equal((await as("put", "/api/admin/settings/pricing", ADMIN, { ratePercent: 99 })).status, 400);
    const ok = await as("put", "/api/admin/settings/pricing", ADMIN, { ratePercent: 15, minFee: 2000, shortFlat: 2000, launchDiscountPercent: 0, guaranteeDays: 30, launchUntil: null });
    assert.equal(ok.status, 200);
    assert.equal(upsert.mock.calls[0].arguments[1].$set.value.rate, 0.15);
    assert.equal(logs.mock.callCount(), 1);
    assert.equal(logs.mock.calls[0].arguments[0].action, "pricing_updated");
    assert.equal(logs.mock.calls[0].arguments[0].details.before.ratePercent, 20);
  });
});

describe("Paiement automatique CinetPay (notification)", () => {
  beforeEach(() => {
    process.env.CINETPAY_APIKEY = "cle";
    process.env.CINETPAY_SITE_ID = "123";
    process.env.PUBLIC_API_URL = "https://api.isd.ci";
  });
  afterEach(() => {
    mock.restoreAll();
    delete process.env.CINETPAY_APIKEY; delete process.env.CINETPAY_SITE_ID; delete process.env.PUBLIC_API_URL;
  });
  const notify = (body) => request(app).post("/api/payments/cinetpay/notify").type("form").send(body);

  test("paiement confirmé par CinetPay : facture réglée", async () => {
    const invoice = fakeInvoice({ gateway: { transactionId: "ISD-ABC234-X" } });
    mock.method(Invoice, "findOne", async () => invoice);
    paidEffects();
    const fetch = mock.method(global, "fetch", async () => ({ json: async () => ({ code: "00", data: { status: "ACCEPTED", amount: "12000", currency: "XOF" } }) }));
    const res = await notify({ cpm_trans_id: "ISD-ABC234-X", cpm_site_id: "123" });
    assert.equal(res.status, 200);
    assert.equal(invoice.status, "paid");
    assert.equal(invoice.method, "cinetpay");
    assert.ok(fetch.mock.calls[0].arguments[0].endsWith("/payment/check"));
  });

  test("montant insuffisant ou statut refusé : la facture reste à payer", async () => {
    const invoice = fakeInvoice({ gateway: { transactionId: "T1" } });
    mock.method(Invoice, "findOne", async () => invoice);
    mock.method(global, "fetch", async () => ({ json: async () => ({ code: "00", data: { status: "ACCEPTED", amount: "100", currency: "XOF" } }) }));
    await notify({ cpm_trans_id: "T1", cpm_site_id: "123" });
    assert.equal(invoice.status, "pending");
  });

  test("site inconnu : ignoré sans appel à CinetPay", async () => {
    const fetch = mock.method(global, "fetch", async () => ({ json: async () => ({}) }));
    const res = await notify({ cpm_trans_id: "T1", cpm_site_id: "999" });
    assert.equal(res.status, 200);
    assert.equal(fetch.mock.callCount(), 0);
  });
});

describe("Garantie de remplacement", () => {
  afterEach(() => mock.restoreAll());
  const paid = (extra) => fakeInvoice({ status: "paid", guaranteeUntil: new Date(Date.now() + 10 * 86400000), ...extra });

  test("dans les 30 jours : offre republiée gratuitement, chat fermé, prestataire prévenu", async () => {
    const invoice = paid();
    mock.method(Invoice, "findOne", async () => invoice);
    mock.method(Offer, "findById", async () => ({ _id: OFFER_ID, family: FAMILY_ID, serviceType: "nanny", description: "Garde d'enfants à Cocody en semaine", duration: "long", agreedPrice: 60000, city: "Abidjan", subjects: [] }));
    const created = mock.method(Offer, "create", async (d) => ({ _id: "nouvelle", ...d }));
    mock.method(Contract, "findOne", async () => null);
    const session = { offerId: OFFER_ID, status: "paid", async save() {} };
    mock.method(ChatSession, "findOne", async () => session);
    mock.method(ChatMessage, "create", async (d) => d);
    const notifs = mock.method(Notification, "create", async () => ({}));
    assert.equal((await as("post", `/api/payments/${OFFER_ID}/replacement`, NANNY, { reason: "Je veux un remplacement svp" })).status, 403);
    const res = await as("post", `/api/payments/${OFFER_ID}/replacement`, FAMILY, { reason: "Horaires finalement incompatibles avec l'école" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const d = created.mock.calls[0].arguments[0];
    assert.equal(d.feeWaived, true);
    assert.equal(d.status, "open");
    assert.equal(d.price, 60000);
    assert.ok(invoice.guaranteeUsedAt);
    assert.equal(session.status, "closed");
    assert.equal(String(notifs.mock.calls[0].arguments[0].userId), PROVIDER_ID);
  });

  test("garantie expirée ou déjà utilisée (409), raison obligatoire (400)", async () => {
    mock.method(Contract, "findOne", async () => null);
    mock.method(Invoice, "findOne", async () => paid({ guaranteeUntil: new Date(Date.now() - 1000) }));
    assert.equal((await as("post", `/api/payments/${OFFER_ID}/replacement`, FAMILY, { reason: "Horaires incompatibles avec l'école" })).status, 409);
    mock.method(Invoice, "findOne", async () => paid({ guaranteeUsedAt: new Date() }));
    assert.equal((await as("post", `/api/payments/${OFFER_ID}/replacement`, FAMILY, { reason: "Horaires incompatibles avec l'école" })).status, 409);
    assert.equal((await as("post", `/api/payments/${OFFER_ID}/replacement`, FAMILY, { reason: "court" })).status, 400);
  });

  test("offre de remplacement : facture offerte et réglée dès la date convenue", async () => {
    mock.method(Invoice, "findOne", async () => null);
    mock.method(Offer, "findById", async () => ({ _id: OFFER_ID, acceptedProvider: PROVIDER_ID, agreedPrice: 60000, duration: "long", feeWaived: true, async save() {} }));
    users({ [PROVIDER_ID]: { pricingType: "month" } });
    mock.method(Setting, "findOne", () => q(null));
    let created;
    mock.method(Invoice, "create", async (d) => { created = { ...d, async save() {} }; return created; });
    mock.method(Contract, "findOne", async () => ({}));
    mock.method(ChatSession, "findOne", async () => null);
    mock.method(Notification, "create", async () => ({}));
    const session = { offerId: OFFER_ID, familyId: FAMILY_ID, providerId: PROVIDER_ID, startDate: new Date() };
    await payment.ensureInvoice(session, null);
    assert.equal(created.amount, 0);
    assert.equal(created.status, "paid");
    assert.equal(created.method, "waived");
  });
});

describe("Contrat", () => {
  afterEach(() => mock.restoreAll());

  test("chaque partie accepte une fois ; l'autre est prévenue", async () => {
    mock.method(Invoice, "findOne", async () => fakeInvoice({ status: "paid" }));
    const contract = { terms: {}, acceptedAt: { family: null, provider: null }, markModified() {}, async save() {} };
    mock.method(Contract, "findOne", async () => contract);
    mock.method(ChatSession, "findOne", async () => null);
    const notifs = mock.method(Notification, "create", async () => ({}));
    // Le préavis doit être choisi avant de confirmer
    assert.equal((await as("post", `/api/payments/${OFFER_ID}/contract/accept`, NANNY)).status, 400);
    const res = await as("post", `/api/payments/${OFFER_ID}/contract/accept`, NANNY, { noticeDays: 7 });
    assert.equal(res.status, 200);
    assert.ok(contract.acceptedAt.provider instanceof Date);
    assert.equal(contract.acceptedAt.family, null);
    assert.equal(contract.terms.noticeDays, 7);
    await as("post", `/api/payments/${OFFER_ID}/contract/accept`, NANNY);
    assert.equal(notifs.mock.callCount(), 1);
  });
});

describe("Paiement et discussions par prestataire", () => {
  afterEach(() => mock.restoreAll());
  const OTHER_PROVIDER = "64b0000000000000000000c2";

  test("facture : jamais depuis la discussion d'un candidat non retenu, ni avant l'accord", async () => {
    mock.method(Invoice, "findOne", async () => null);
    mock.method(Offer, "findById", async () => ({ _id: OFFER_ID, acceptedProvider: PROVIDER_ID, agreedPrice: 60000, duration: "long" }));
    const create = mock.method(Invoice, "create", async (d) => d);
    const other = { offerId: OFFER_ID, familyId: FAMILY_ID, providerId: OTHER_PROVIDER, status: "active", startDate: new Date() };
    assert.equal(await payment.ensureInvoice(other, null), null);
    assert.equal(await payment.ensureInvoice({ ...other, providerId: PROVIDER_ID, status: "discussion" }, null), null);
    assert.equal(create.mock.callCount(), 0);
  });

  test("paiement confirmé : coordonnées débloquées dans la seule discussion de l'accord", async () => {
    const { session } = paidEffects();
    const filters = [];
    mock.method(ChatSession, "findOne", async (f) => { filters.push(f); return session; });
    const msgs = mock.method(ChatMessage, "create", async (d) => d);
    await payment.markPaid(fakeInvoice({ status: "submitted" }), { method: "manual" });
    assert.ok(filters.length > 0);
    for (const f of filters) assert.equal(String(f.providerId), PROVIDER_ID);
    assert.equal(session.isPaid, true);
    assert.equal(msgs.mock.calls[0].arguments[0].providerId, PROVIDER_ID);
  });

  test("facture créée à la consultation : seulement via la discussion du prestataire retenu", async () => {
    mock.method(Invoice, "findOne", async () => null);
    mock.method(Offer, "findById", () => q({ _id: OFFER_ID, acceptedProvider: PROVIDER_ID }));
    let filter;
    mock.method(ChatSession, "findOne", async (f) => { filter = f; return null; });
    const res = await as("get", `/api/payments/${OFFER_ID}`, tokenFor(OTHER_PROVIDER, "nanny"));
    assert.equal(res.status, 404);
    assert.equal(String(filter.providerId), PROVIDER_ID);
  });
});

describe("Unité figée à l'accord", () => {
  afterEach(() => mock.restoreAll());

  test("la facture utilise l'unité convenue (offer.agreedUnit), pas l'unité actuelle du profil", async () => {
    mock.method(Invoice, "findOne", async () => null);
    mock.method(Offer, "findById", async () => ({ _id: OFFER_ID, acceptedProvider: PROVIDER_ID, agreedPrice: 3000, agreedUnit: "hour", duration: "long" }));
    users({ [PROVIDER_ID]: { pricingType: "month" } });
    mock.method(Setting, "findOne", () => q(null));
    let created;
    mock.method(Invoice, "create", async (d) => { created = { ...d, async save() {} }; return created; });
    mock.method(ChatMessage, "create", async (d) => d);
    mock.method(Notification, "create", async () => ({}));
    const session = { offerId: OFFER_ID, familyId: FAMILY_ID, providerId: PROVIDER_ID, status: "agreement_reached", startDate: new Date() };
    await payment.ensureInvoice(session, null);
    assert.equal(created.breakdown.unit, "hour");
    const expected = computeFee({ agreedPrice: 3000, unit: "hour", duration: "long", waived: false }, DEFAULT_PRICING);
    assert.equal(created.amount, expected.amount);
  });
});

describe("Mes missions : noms avant paiement", () => {
  afterEach(() => mock.restoreAll());

  test("initiale tant que la facture n'est pas réglée, nom complet ensuite", async () => {
    mock.method(Invoice, "find", () => q([fakeInvoice({ status: "pending" }), fakeInvoice({ status: "paid", offerId: "64b0000000000000000000b2" })]));
    mock.method(Offer, "findById", () => q({ description: "Garde" }));
    mock.method(User, "findById", () => q({ firstName: "Aya", lastName: "Kouassi" }));
    mock.method(Contract, "findOne", () => q(null));
    const res = await as("get", "/api/payments/mine", FAMILY);
    assert.equal(res.status, 200);
    assert.equal(res.body[0].other.lastName, "K.");
    assert.equal(res.body[1].other.lastName, "Kouassi");
  });
});
