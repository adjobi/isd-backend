// Tableau de bord de l'Espace ISD : audience, inscriptions, activité, rétention, mises en relation,
// paiements et qualité, sur une période (7 j, 30 j, 90 j, 12 mois) comparée à la précédente.
// Heure d'Abidjan = UTC : les jours et les mois sont ceux de l'UTC.
const Visit = require("../models/Visit");
const UserActivity = require("../models/UserActivity");
const User = require("../models/User");
const Offer = require("../models/Offer");
const Invoice = require("../models/Invoice");
const Contract = require("../models/Contract");
const MissionReview = require("../models/MissionReview");
const Report = require("../models/Report");
const SupportRequest = require("../models/SupportRequest");

const DAY = 24 * 3600 * 1000;
const WEEK = 7 * DAY;
const PERIODS = { "7d": { days: 7 }, "30d": { days: 30 }, "90d": { days: 90 }, "12m": { months: 12 } };
const ROLES = ["family", "nanny", "tutor"];

const startOfDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addMonths = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
const dayKey = (d) => d.toISOString().slice(0, 10);
const monthKey = (d) => d.toISOString().slice(0, 7);

// Bornes de la période, de la précédente et liste des intervalles (jours ou mois).
function range(period, now = new Date()) {
  const p = PERIODS[period] || PERIODS["30d"];
  let start, prevStart, buckets;
  const end = new Date(now.getTime() + 1);
  if (p.months) {
    start = addMonths(now, -(p.months - 1));
    prevStart = addMonths(start, -p.months);
    buckets = Array.from({ length: p.months }, (_, i) => monthKey(addMonths(start, i)));
  } else {
    start = new Date(startOfDay(now).getTime() - (p.days - 1) * DAY);
    prevStart = new Date(start.getTime() - p.days * DAY);
    buckets = Array.from({ length: p.days }, (_, i) => dayKey(new Date(start.getTime() + i * DAY)));
  }
  return { period: PERIODS[period] ? period : "30d", unit: p.months ? "month" : "day", start, end, prevStart, buckets };
}

const fmt = (r) => (r.unit === "month" ? "%Y-%m" : "%Y-%m-%d");
const between = (field, a, b) => ({ [field]: { $gte: a, $lt: b } });
const toMap = (rows, key = "_id", val = "n") => Object.fromEntries(rows.map((x) => [x[key], x[val]]));
const series = (r, map) => r.buckets.map((b) => map[b] || 0);
const round = (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d;

// Visites = visiteurs uniques par jour (empreinte du jour), additionnés sur la période.
async function audience(r) {
  const visitorDays = [
    { $match: between("createdAt", r.prevStart, r.end) },
    { $sort: { createdAt: 1 } },
    { $group: { _id: { day: "$day", kind: "$kind", visitor: "$visitor" }, views: { $sum: 1 }, source: { $first: "$source" }, device: { $first: "$device" }, at: { $first: "$createdAt" } } },
  ];
  const rows = await Visit.aggregate([
    ...visitorDays,
    {
      $facet: {
        byBucket: [
          { $match: { at: { $gte: r.start } } },
          { $group: { _id: { b: r.unit === "month" ? { $substrCP: ["$_id.day", 0, 7] } : "$_id.day", kind: "$_id.kind" }, visits: { $sum: 1 }, views: { $sum: "$views" } } },
        ],
        prev: [
          { $match: { at: { $lt: r.start } } },
          { $group: { _id: "$_id.kind", visits: { $sum: 1 } } },
        ],
        sources: [
          { $match: { at: { $gte: r.start } } },
          { $group: { _id: "$source", n: { $sum: 1 } } }, { $sort: { n: -1 } },
        ],
        devices: [
          { $match: { at: { $gte: r.start } } },
          { $group: { _id: "$device", n: { $sum: 1 } } },
        ],
      },
    },
  ]);
  const f = rows[0] || { byBucket: [], prev: [], sources: [], devices: [] };
  const pages = await Visit.aggregate([
    { $match: { ...between("createdAt", r.start, r.end), kind: "site" } },
    { $group: { _id: "$path", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 },
  ]);
  const pick = (kind, field) => toMap(f.byBucket.filter((x) => x._id.kind === kind).map((x) => ({ _id: x._id.b, n: x[field] })));
  const site = series(r, pick("site", "visits"));
  const app = series(r, pick("app", "visits"));
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const prev = toMap(f.prev, "_id", "visits");
  const top = f.sources.slice(0, 6);
  const other = sum(f.sources.slice(6).map((x) => x.n));
  return {
    site, app,
    total: { site: sum(site), app: sum(app), views: sum(f.byBucket.map((x) => x.views)) },
    prev: { site: prev.site || 0, app: prev.app || 0 },
    sources: [...top.map((x) => ({ key: x._id, n: x.n })), ...(other ? [{ key: "autre", n: other }] : [])],
    devices: toMap(f.devices),
    pages: pages.map((x) => ({ path: x._id, n: x.n })),
  };
}

async function signups(r) {
  const [rows, prev, communes, totals] = await Promise.all([
    User.aggregate([
      { $match: between("createdAt", r.start, r.end) },
      { $group: { _id: { b: { $dateToString: { format: fmt(r), date: "$createdAt" } }, role: "$role" }, n: { $sum: 1 } } },
    ]),
    User.countDocuments(between("createdAt", r.prevStart, r.start)),
    User.aggregate([
      { $match: between("createdAt", r.start, r.end) },
      { $group: { _id: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$commune", ""] } }, 0] }, "$commune", { $ifNull: ["$city", "Non renseignée"] }] }, n: { $sum: 1 } } },
      { $sort: { n: -1 } }, { $limit: 8 },
    ]),
    User.aggregate([{ $group: { _id: "$role", n: { $sum: 1 } } }]),
  ]);
  const byRole = Object.fromEntries(ROLES.map((role) => [role, series(r, toMap(rows.filter((x) => x._id.role === role).map((x) => ({ _id: x._id.b, n: x.n }))))]));
  const total = rows.reduce((s, x) => s + x.n, 0);
  return { byRole, total, prev, communes: communes.map((x) => ({ name: x._id, n: x.n })), allTime: toMap(totals) };
}

// Actifs = comptes ayant ouvert l'app au moins une fois (par jour, ou par mois en vue 12 mois).
async function activity(r, now) {
  const [rows, cur, prev, last7, last30] = await Promise.all([
    UserActivity.aggregate([
      { $match: between("at", r.start, r.end) },
      { $group: { _id: r.unit === "month" ? { $substrCP: ["$day", 0, 7] } : "$day", users: { $addToSet: "$user" } } },
      { $project: { n: { $size: "$users" } } },
    ]),
    UserActivity.distinct("user", between("at", r.start, r.end)),
    UserActivity.distinct("user", between("at", r.prevStart, r.start)),
    UserActivity.distinct("user", between("at", new Date(now.getTime() - 7 * DAY), r.end)),
    UserActivity.distinct("user", between("at", new Date(now.getTime() - 30 * DAY), r.end)),
  ]);
  return { series: series(r, toMap(rows)), total: cur.length, prev: prev.length, last7: last7.length, last30: last30.length };
}

// Rétention par semaine d'inscription (8 dernières semaines, semaines du lundi) :
// part des inscrits revenus dans l'app 1, 2, 3 et 4 semaines après leur semaine d'inscription.
async function retention(now) {
  const today = startOfDay(now);
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY);
  const first = new Date(monday.getTime() - 7 * WEEK);
  const users = await User.find({ createdAt: { $gte: first } }).select("_id createdAt").lean();
  if (!users.length) return [];
  const acts = await UserActivity.find({ user: { $in: users.map((u) => u._id) }, at: { $gte: first } }).select("user at").lean();
  const byUser = new Map();
  acts.forEach((a) => {
    const k = String(a.user);
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k).push(new Date(a.at).getTime());
  });
  return Array.from({ length: 8 }, (_, i) => {
    const ws = first.getTime() + i * WEEK;
    const cohort = users.filter((u) => { const t = new Date(u.createdAt).getTime(); return t >= ws && t < ws + WEEK; });
    const weeks = [1, 2, 3, 4].map((k) => {
      const a = ws + k * WEEK;
      if (a > now.getTime()) return null; // semaine pas encore commencée
      if (!cohort.length) return null;
      const back = cohort.filter((u) => (byUser.get(String(u._id)) || []).some((t) => t >= a && t < a + WEEK)).length;
      return round((back / cohort.length) * 100);
    });
    return { week: dayKey(new Date(ws)), size: cohort.length, weeks };
  });
}

async function marketplace(r) {
  const inRange = between("createdAt", r.start, r.end);
  const [offers, families, withApps, invoices, paid, replacements] = await Promise.all([
    Offer.countDocuments(inRange),
    Offer.distinct("family", inRange),
    Offer.countDocuments({ ...inRange, "applications.0": { $exists: true } }),
    Invoice.countDocuments({ ...inRange, status: { $ne: "cancelled" } }),
    Invoice.countDocuments({ ...between("paidAt", r.start, r.end), status: "paid" }),
    Offer.countDocuments({ ...inRange, replacementOf: { $ne: null } }),
  ]);
  return { offers, families: families.length, withApplications: withApps, matches: invoices, paid, replacements };
}

async function payments(r) {
  const paidRange = { ...between("paidAt", r.start, r.end), status: "paid" };
  const [rows, prev, ops, backlog, rejected, waived, delay] = await Promise.all([
    Invoice.aggregate([
      { $match: paidRange },
      { $group: { _id: { $dateToString: { format: fmt(r), date: "$paidAt" } }, n: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    Invoice.aggregate([{ $match: { ...between("paidAt", r.prevStart, r.start), status: "paid" } }, { $group: { _id: null, n: { $sum: "$amount" }, count: { $sum: 1 } } }]),
    Invoice.aggregate([{ $match: paidRange }, { $group: { _id: { $ifNull: ["$declaration.operator", "$method"] }, n: { $sum: 1 }, amount: { $sum: "$amount" } } }, { $sort: { n: -1 } }]),
    Invoice.aggregate([{ $match: { status: { $in: ["submitted", "pending"] } } }, { $group: { _id: "$status", n: { $sum: 1 }, amount: { $sum: "$amount" } } }]),
    Invoice.countDocuments({ ...between("updatedAt", r.start, r.end), status: "rejected" }),
    Invoice.countDocuments({ ...between("createdAt", r.start, r.end), status: "waived" }),
    Invoice.aggregate([
      { $match: { ...paidRange, "declaration.at": { $ne: null }, verifiedAt: { $ne: null } } },
      { $group: { _id: null, ms: { $avg: { $subtract: ["$verifiedAt", "$declaration.at"] } } } },
    ]),
  ]);
  const revenue = series(r, toMap(rows));
  const total = revenue.reduce((s, x) => s + x, 0);
  const count = rows.reduce((s, x) => s + x.count, 0);
  const b = Object.fromEntries(backlog.map((x) => [x._id, { n: x.n, amount: x.amount }]));
  return {
    revenue, total, count, average: count ? Math.round(total / count) : 0,
    prev: prev[0]?.n || 0, prevCount: prev[0]?.count || 0,
    operators: ops.map((x) => ({ key: x._id || "autre", n: x.n, amount: x.amount })),
    toVerify: b.submitted || { n: 0, amount: 0 }, unpaid: b.pending || { n: 0, amount: 0 },
    rejected, waived,
    verifyHours: delay[0]?.ms ? round(delay[0].ms / 3600000, 1) : null,
  };
}

async function quality(r) {
  const inRange = between("createdAt", r.start, r.end);
  const [reviews, reports, openReports, ended, active, providers, available, support, openSupport] = await Promise.all([
    MissionReview.aggregate([{ $match: { ...inRange, status: "published" } }, { $group: { _id: null, n: { $sum: 1 }, avg: { $avg: "$rating" } } }]),
    Report.countDocuments(inRange),
    Report.countDocuments({ status: "open" }),
    Contract.aggregate([{ $match: between("endedAt", r.start, r.end) }, { $group: { _id: "$endReason", n: { $sum: 1 } } }]),
    Contract.countDocuments({ "acceptedAt.family": { $ne: null }, "acceptedAt.provider": { $ne: null }, endedAt: null }),
    User.countDocuments({ role: { $in: ["nanny", "tutor"] } }),
    User.countDocuments({ role: { $in: ["nanny", "tutor"] }, availability: "available" }),
    SupportRequest.countDocuments(inRange),
    SupportRequest.countDocuments({ status: "open" }),
  ]);
  return {
    reviews: reviews[0]?.n || 0, rating: reviews[0]?.avg ? round(reviews[0].avg, 1) : null,
    reports, openReports, ended: toMap(ended.map((x) => ({ _id: x._id || "autre", n: x.n }))),
    activeMissions: active, providers, availableProviders: available, support, openSupport,
  };
}

const cache = new Map();
async function dashboard(period, now = new Date()) {
  const r = range(period, now);
  const hit = cache.get(r.period);
  if (hit && now.getTime() - hit.at < 60 * 1000) return hit.value;
  const [aud, sig, act, ret, mkt, pay, qual] = await Promise.all([
    audience(r), signups(r), activity(r, now), retention(now), marketplace(r), payments(r), quality(r),
  ]);
  const value = {
    period: r.period, unit: r.unit, buckets: r.buckets, generatedAt: now,
    audience: aud, signups: sig, activity: act, retention: ret, marketplace: mkt, payments: pay, quality: qual,
  };
  cache.set(r.period, { at: now.getTime(), value });
  return value;
}
dashboard.clearCache = () => cache.clear();

module.exports = { dashboard, range, PERIODS };
