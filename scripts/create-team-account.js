// Crée le compte dédié à l'équipe ISD (Espace ISD), distinct de tout compte personnel.
// Le mot de passe est demandé dans le terminal, sans être affiché ni enregistré dans l'historique.
// Usage : npm run create-team-account -- equipe@exemple.com
// Base locale par défaut. Sur le serveur en ligne, ajouter --production (choix explicite) :
//   sudo docker compose exec api node scripts/create-team-account.js equipe@exemple.com --production
// Le compte ne se connecte que par « Équipe ISD » ; activez ensuite la double authentification.
require("dotenv").config();
const readline = require("readline");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const User = require("../models/User");

const uri = process.env.MONGO_URI || "";
const email = (process.argv[2] || "").trim().toLowerCase();
const production = process.argv.includes("--production");

// Saisie masquée : rien ne s'affiche pendant la frappe.
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.startsWith(question)) rl.output.write(question); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

(async () => {
  if (!production && !/^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri)) {
    console.error("Refusé : base distante. Sur le serveur en ligne, ajoutez --production.");
    process.exit(1);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    console.error("Usage : npm run create-team-account -- equipe@exemple.com");
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error("Lancez ce script dans un terminal : le mot de passe doit être saisi au clavier.");
    process.exit(1);
  }
  await mongoose.connect(uri);
  if (await User.exists({ email })) {
    console.error(`Un compte existe déjà pour ${email}. Choisissez une autre adresse (ou utilisez make-admin pour un compte existant).`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const password = await askHidden("Mot de passe du compte équipe (12 caractères minimum) : ");
  if (password.length < 12) {
    console.error("Trop court : 12 caractères minimum pour le compte qui valide les paiements et les identités.");
    await mongoose.disconnect();
    process.exit(1);
  }
  const again = await askHidden("Confirmez le mot de passe : ");
  if (again !== password) {
    console.error("Les deux saisies sont différentes. Rien n'a été créé.");
    await mongoose.disconnect();
    process.exit(1);
  }
  const user = await User.create({
    role: "family", email, password: await bcrypt.hash(password, 10),
    firstName: "Équipe", lastName: "ISD", phone: "0000000000", city: "Abidjan", isAdmin: true, teamOnly: true,
  });
  console.log(`Compte équipe créé : ${user.email}`);
  console.log("Étape suivante : dans l'application, accueil → « Équipe ISD » → connexion,");
  console.log("puis « Sécurité du compte » pour activer la double authentification.");
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error("Création impossible :", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
