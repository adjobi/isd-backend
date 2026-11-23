const { test, describe, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const Notification = require("../models/Notification");
const { tokenFor, buildApp } = require("./helpers");

const app = buildApp();
const ME = "64b0000000000000000000a1";
const TOKEN = tokenFor(ME, "family");

describe("Notifications", () => {
  afterEach(() => mock.restoreAll());

  test("liste uniquement mes notifications, pagination bornée", async () => {
    let filter; let limit;
    mock.method(Notification, "find", (f) => { filter = f; const q = { sort: () => q, skip: () => q, limit: (l) => { limit = l; return q; }, lean: async () => [] }; return q; });
    mock.method(Notification, "countDocuments", async () => 0);
    const res = await request(app).get("/api/notifications?limit=100000").set("Authorization", `Bearer ${TOKEN}`);
    assert.equal(res.status, 200);
    assert.equal(filter.userId, ME);
    assert.equal(limit, 50);
  });

  test("identifiant malformé → 400, erreur technique masquée → 500 générique", async () => {
    const bad = await request(app).put("/api/notifications/pas-un-id/read").set("Authorization", `Bearer ${TOKEN}`);
    assert.equal(bad.status, 400);
    mock.method(Notification, "countDocuments", async () => { throw new Error("Mongo down"); });
    mock.method(console, "error", () => {});
    const err = await request(app).get("/api/notifications/unread-count").set("Authorization", `Bearer ${TOKEN}`);
    assert.equal(err.status, 500);
    assert.doesNotMatch(err.body.message, /Mongo/);
  });

  test("refuse sans connexion (401)", async () => {
    assert.equal((await request(app).get("/api/notifications")).status, 401);
  });
});
