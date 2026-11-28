// Avant le paiement de la facture ISD, seuls le prénom et l'initiale du nom sont montrés
// (« Kouassi » → « K. ») : le nom complet est disponible avec les coordonnées après paiement.
function lastNameInitial(lastName) {
  const s = String(lastName || "").trim();
  if (!s) return "";
  return `${Array.from(s)[0].toLocaleUpperCase("fr-FR")}.`;
}

// Copie d'un utilisateur (objet simple) avec le nom réduit à son initiale.
// Un identifiant (non peuplé) est renvoyé tel quel.
function maskName(user) {
  if (!user || typeof user !== "object" || !("lastName" in user)) return user;
  return { ...user, lastName: lastNameInitial(user.lastName) };
}

// Document Mongoose ou objet : version simple, nom réduit à l'initiale.
const toPlain = (v) => (v && typeof v.toObject === "function" ? v.toObject() : v);
const maskNames = (list) => (Array.isArray(list) ? list.map((u) => maskName(toPlain(u))) : list);

module.exports = { lastNameInitial, maskName, maskNames, toPlain };
