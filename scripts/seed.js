// Données de démonstration pour le développement local.
//   npm run seed
// - Refuse de tourner sur une base distante (sécurité).
// - Idempotent : met à jour les comptes de démo par email, ne supprime rien.
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Offer = require("../models/Offer");

const PASSWORD = "Demo1234";

const uri = process.env.MONGO_URI || "";
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri)) {
  console.error("❌ Seed refusé : MONGO_URI doit pointer vers une base locale (mongodb://localhost:27017/...).");
  process.exit(1);
}

const USERS = [
  {
    role: "family", email: "famille@demo.isd", firstName: "Awa", lastName: "Koné",
    phone: "+2250700000001", city: "Abidjan", commune: "Cocody",
  },
  {
    role: "nanny", serviceType: "nanny", email: "aya.nounou@demo.isd", firstName: "Aya Marie", lastName: "Kouassi",
    phone: "+2250700000002", city: "Abidjan", commune: "Cocody",
    pricingType: "month", pricingAmount: 60000, rating: 4.8, isVerified: true, availability: "available",
    bio: "Nounou depuis 8 ans, j’adore accompagner les tout-petits. Formée aux premiers secours.",
    skills: ["Premiers secours", "Cuisine", "Aide aux devoirs"], values: ["Ponctualité", "Bienveillance"],
  },
  {
    role: "nanny", serviceType: "nanny", email: "fatou.nounou@demo.isd", firstName: "Fatou", lastName: "Traoré",
    phone: "+2250700000003", city: "Abidjan", commune: "Marcory",
    pricingType: "month", pricingAmount: 45000, rating: 0, availability: "available",
    bio: "Maman de trois enfants, disponible en semaine.",
  },
  {
    role: "tutor", serviceType: "tutor", email: "jeanmarc.repetiteur@demo.isd", firstName: "Jean-Marc", lastName: "Yao",
    phone: "+2250700000004", city: "Abidjan", commune: "Yopougon",
    pricingType: "hour", pricingAmount: 5000, rating: 4.3, availability: "busy",
    subjects: ["Mathématiques", "Physique-Chimie", "SVT"],
    bio: "Professeur de collège, spécialiste de la préparation au BEPC.",
  },
  {
    role: "tutor", serviceType: "tutor", email: "koffi.repetiteur@demo.isd", firstName: "Koffi", lastName: "Brou",
    phone: "+2250700000005", city: "Abidjan", commune: "Plateau",
    pricingType: "hour", pricingAmount: 6000, rating: 4.6, isVerified: true, availability: "available",
    subjects: ["Anglais", "Français", "Philosophie"],
  },
];

(async () => {
  await mongoose.connect(uri);
  const hash = await bcrypt.hash(PASSWORD, 10);
  const byEmail = {};
  for (const u of USERS) {
    byEmail[u.email] = await User.findOneAndUpdate(
      { email: u.email },
      { $set: { ...u, password: hash, isProfileCompleted: true } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
  const family = byEmail["famille@demo.isd"];

  const OFFERS = [
    {
      serviceType: "nanny", duration: "long", price: 0, city: "Abidjan",
      description: "[démo] Nous cherchons une nounou pour nos 2 enfants (3 et 6 ans), du lundi au vendredi de 7h à 18h à Cocody.",
      applications: [
        { provider: byEmail["aya.nounou@demo.isd"]._id, status: "pending" },
        { provider: byEmail["fatou.nounou@demo.isd"]._id, status: "pending" },
      ],
    },
    {
      serviceType: "tutor", duration: "short", price: 40000, city: "Abidjan", subjects: ["Mathématiques"],
      description: "[démo] Cours de maths pour mon fils en 3e, 2 séances par semaine pour préparer le BEPC.",
      applications: [],
    },
  ];
  let created = 0;
  for (const o of OFFERS) {
    const exists = await Offer.findOne({ family: family._id, description: o.description });
    if (!exists) { await Offer.create({ ...o, family: family._id }); created++; }
  }

  console.log(`✅ ${USERS.length} comptes de démo à jour, ${created} offre(s) créée(s).`);
  console.log(`   Mot de passe commun : ${PASSWORD}`);
  USERS.forEach((u) => console.log(`   - ${u.role.padEnd(6)} ${u.email}`));
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("❌ Seed échoué :", e.message);
  await mongoose.disconnect();
  process.exit(1);
});
