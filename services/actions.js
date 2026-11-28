// Actions en attente de l'utilisateur : ce que l'autre partie (ou ISD) attend de lui.
// Calculées à la demande à partir des vraies données, jamais stockées : une action disparaît
// d'elle-même dès qu'elle est faite.
const Offer = require("../models/Offer");
const Invoice = require("../models/Invoice");
const Contract = require("../models/Contract");
const User = require("../models/User");
const { ChatSession } = require("../models/Chat");
const MissionReview = require("../models/MissionReview");
const IdentityCheck = require("../models/IdentityCheck");
const { reviewOpensAt } = require("./reviews");
const { stageOf, turnOf, lastBy } = require("./applications");

const idOf = (v) => String(v?._id || v);
const shortName = (u) => (u ? [u.firstName, u.lastName ? `${u.lastName[0]}.` : ""].filter(Boolean).join(" ") : "");
const plural = (n, one, many) => (n > 1 ? many : one);
const formatDay = (d) => new Date(d).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "Africa/Abidjan" });

// Ordre d'affichage : ce qui bloque l'autre partie ou engage de l'argent d'abord.
const PRIORITY = {
  end_response: 1, payment_rejected: 2, payment: 3, notice_confirm: 4, engagements: 5,
  applications: 6, counter_offer: 6, mission_confirm: 6, salary_propose: 6, start_date_reply: 7, start_date_propose: 8, review: 9,
  identity: 10,
};
// Après un refus, on laisse 24 h avant de reproposer la vérification d'identité.
const IDENTITY_RETRY_MS = 24 * 60 * 60 * 1000;
// On propose de donner son avis pendant 60 jours, sans relancer ensuite.
const REVIEW_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

async function pendingActions(userId, tokenRole) {
  const me = String(userId);
  const isFamily = tokenRole === "family";
  const actions = [];
  // Identifiant stable : type + offre ; une action sans offre (ex. identité) fournit le sien.
  const add = (a) => actions.push({ ...a, id: a.id || `${a.kind}:${a.params.offerId}`, priority: PRIORITY[a.kind] });

  const [offers, sessions, invoices, contracts, confirmed] = await Promise.all([
    isFamily
      ? Offer.find({ family: me, status: "open" }).select("description applications updatedAt").lean()
      : Offer.find({ status: "open", "applications.provider": me }).select("description family applications updatedAt").lean(),
    // Discussions de l'accord conclu (pas les discussions en cours avant l'accord)
    ChatSession.find({ [isFamily ? "familyId" : "providerId"]: me, status: { $nin: ["closed", "discussion"] }, startDate: null })
      .select("_id offerId familyId providerId startDateProposal createdAt").lean(),
    isFamily ? Invoice.find({ family: me, status: { $in: ["pending", "rejected"] } }).select("offerId status amount reference updatedAt").lean() : [],
    Contract.find({ [isFamily ? "family" : "provider"]: me, $or: [{ endedAt: null }, { endedAt: { $gt: new Date() } }] })
      .select("offerId family provider acceptedAt terms.noticeDays terms.noticeSetBy termination endedAt updatedAt").lean(),
    // Missions sur lesquelles la famille peut donner son avis
    isFamily
      ? Contract.find({ family: me, "acceptedAt.family": { $ne: null }, "acceptedAt.provider": { $ne: null } })
        .select("offerId provider acceptedAt terms.startDate endedAt").lean()
      : [],
  ]);
  const now = Date.now();
  const reviewable = confirmed.filter((c) => {
    const opens = reviewOpensAt(c)?.getTime();
    return opens && opens <= now && now - opens < REVIEW_WINDOW_MS;
  });
  const reviewed = reviewable.length
    ? new Set((await MissionReview.find({ contractId: { $in: reviewable.map((c) => c._id) } }).select("contractId").lean()).map((r) => idOf(r.contractId)))
    : new Set();
  const toReview = reviewable.filter((c) => !reviewed.has(idOf(c)));

  // Noms et descriptions utiles aux libellés, en deux requêtes
  const offerIds = new Set([...sessions.map((s) => idOf(s.offerId)), ...invoices.map((i) => idOf(i.offerId)), ...contracts.map((c) => idOf(c.offerId))]);
  const userIds = new Set([
    ...sessions.map((s) => idOf(isFamily ? s.providerId : s.familyId)),
    ...contracts.map((c) => idOf(isFamily ? c.provider : c.family)),
    ...toReview.map((c) => idOf(c.provider)),
    ...offers.filter((o) => o.family).map((o) => idOf(o.family)),
    ...(isFamily ? offers.flatMap((o) => (o.applications || []).filter((a) => ["discussion", "salary"].includes(stageOf(a))).map((a) => idOf(a.provider))) : []),
  ]);
  const [offerDocs, users] = await Promise.all([
    offerIds.size ? Offer.find({ _id: { $in: [...offerIds] } }).select("description").lean() : [],
    userIds.size ? User.find({ _id: { $in: [...userIds] } }).select("firstName lastName").lean() : [],
  ]);
  const describe = (id) => offerDocs.find((o) => idOf(o) === idOf(id))?.description || "";
  const nameOf = (id) => shortName(users.find((u) => idOf(u) === idOf(id))) || (isFamily ? "Le prestataire" : "La famille");

  // Candidatures, accord sur la mission et négociation du salaire (une action par discussion)
  const myRole = isFamily ? "family" : "provider";
  const discussionActions = (o, a, other) => {
    const stage = stageOf(a);
    const params = { offerId: idOf(o), providerId: idOf(a.provider), sessionId: a.sessionId ? idOf(a.sessionId) : null };
    const id = (kind) => `${kind}:${idOf(o)}:${idOf(a.provider)}`;
    if (stage === "discussion") {
      const agreed = a.missionAgreed || {};
      if (agreed[isFamily ? "provider" : "family"] && !agreed[myRole]) {
        add({
          kind: "mission_confirm", id: id("mission_confirm"), params, at: agreed[isFamily ? "provider" : "family"],
          title: `${other} est d'accord sur la mission`,
          text: "Confirmez à votre tour quand la mission vous convient.", cta: "Ouvrir la discussion", route: "Chat",
        });
      }
    } else if (stage === "salary") {
      const turn = turnOf(a);
      if (turn === "either") {
        add({
          kind: "salary_propose", id: id("salary_propose"), params, at: a.missionAgreed?.family || o.updatedAt,
          title: `Convenez du salaire avec ${other}`,
          text: "La mission est validée : faites une proposition de salaire.", cta: "Proposer", route: "Chat",
        });
      } else if (turn === myRole && lastBy(a)) {
        add({
          kind: "counter_offer", id: id("counter_offer"), params, at: o.updatedAt,
          title: `${other} vous propose un salaire`,
          text: o.description, cta: "Répondre", route: "Chat",
        });
      }
    }
  };
  for (const o of offers) {
    if (isFamily) {
      const waiting = (o.applications || []).filter((a) => stageOf(a) === "applied");
      if (waiting.length) {
        add({
          kind: "applications", params: { offerId: idOf(o) }, at: o.updatedAt,
          title: `${waiting.length} ${plural(waiting.length, "candidature attend", "candidatures attendent")} votre réponse`,
          text: o.description, cta: "Voir les candidats", route: "OfferDetail",
        });
      }
      for (const a of o.applications || []) discussionActions(o, a, nameOf(a.provider));
    } else {
      const mine = (o.applications || []).find((a) => idOf(a.provider) === me);
      if (mine) discussionActions(o, mine, nameOf(o.family));
    }
  }

  // Date de début à convenir dans le chat
  for (const s of sessions) {
    const other = nameOf(isFamily ? s.providerId : s.familyId);
    const p = s.startDateProposal;
    if (p?.date && p.by && p.by !== myRole) {
      add({
        kind: "start_date_reply", params: { offerId: idOf(s.offerId), sessionId: s._id ? idOf(s._id) : null }, at: p.at,
        title: `${other} propose de commencer le ${formatDay(p.date)}`,
        text: "Confirmez la date ou proposez-en une autre dans le chat.", cta: "Répondre", route: "Chat",
      });
    } else if (!p?.date) {
      add({
        kind: "start_date_propose", params: { offerId: idOf(s.offerId), sessionId: s._id ? idOf(s._id) : null }, at: s.createdAt,
        title: `Convenez d'une date de début avec ${other}`,
        text: describe(s.offerId), cta: "Ouvrir le chat", route: "Chat",
      });
    }
  }

  // Facture ISD (famille)
  for (const inv of invoices) {
    const rejected = inv.status === "rejected";
    add({
      kind: rejected ? "payment_rejected" : "payment", params: { offerId: idOf(inv.offerId) }, at: inv.updatedAt,
      title: rejected ? "Paiement non confirmé : vérifiez votre déclaration" : "Réglez la facture ISD pour obtenir les coordonnées",
      text: describe(inv.offerId), cta: rejected ? "Corriger" : "Voir la facture", route: "Payment",
    });
  }

  // Engagements à confirmer et fin de mission
  for (const c of contracts) {
    const other = nameOf(isFamily ? c.provider : c.family);
    const params = { offerId: idOf(c.offerId) };
    const t = c.termination;
    if (t?.status === "proposed" && t.by !== myRole) {
      add({
        kind: "end_response", params, at: t.requestedAt,
        title: `${other} propose de terminer la mission le ${formatDay(t.effectiveAt)}`,
        text: "Acceptez ou refusez cette proposition.", cta: "Répondre", route: "Mission",
      });
    }
    if (!c.endedAt && !c.acceptedAt?.[myRole]) {
      const n = c.terms?.noticeDays;
      const proposedByOther = Number.isInteger(n) && c.terms?.noticeSetBy && c.terms.noticeSetBy !== myRole;
      add({
        kind: proposedByOther ? "notice_confirm" : "engagements", params, at: c.updatedAt,
        title: proposedByOther
          ? `${other} propose ${n === 0 ? "aucun préavis" : `un préavis de ${n} jour${n > 1 ? "s" : ""}`}`
          : `Confirmez vos engagements avec ${other}`,
        text: proposedByOther ? "Confirmez cette durée ou proposez-en une autre." : "Choisissez ensemble la durée du préavis, puis confirmez le récapitulatif.",
        cta: "Confirmer", route: "Mission",
      });
    }
  }

  // Avis sur la mission (famille)
  for (const c of toReview) {
    add({
      kind: "review", params: { offerId: idOf(c.offerId) }, at: reviewOpensAt(c),
      title: `Comment se passe la mission avec ${nameOf(c.provider)} ?`,
      text: "Votre avis aide les autres familles à choisir. Il ne prend qu'une minute.", cta: "Donner mon avis", route: "Mission",
    });
  }

  // Vérification d'identité (prestataire non vérifié, sans demande en cours ni refus récent)
  if (!isFamily) {
    const [user, check] = await Promise.all([
      User.findById(me).select("role isVerified createdAt").lean(),
      IdentityCheck.findOne({ user: me }).sort({ submittedAt: -1 }).select("status decidedAt submittedAt").lean(),
    ]);
    const recentlyRejected = check?.status === "rejected" && now - new Date(check.decidedAt || check.submittedAt).getTime() < IDENTITY_RETRY_MS;
    if (user && ["nanny", "tutor"].includes(user.role) && !user.isVerified && check?.status !== "pending" && !recentlyRejected) {
      add({
        kind: "identity", id: "identity", params: {}, at: check?.decidedAt || user.createdAt,
        title: "Faites vérifier votre identité",
        text: "Les familles choisissent plus souvent un profil vérifié.", cta: "Vérifier mon identité", route: "IdentityVerification",
      });
    }
  }

  return actions.sort((a, b) => a.priority - b.priority || new Date(b.at) - new Date(a.at));
}

module.exports = { pendingActions, PRIORITY };
