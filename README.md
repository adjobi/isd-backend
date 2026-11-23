# ISD — Backend

API Node.js / Express / MongoDB de la plateforme ISD (familles, nounous, répétiteurs).
L'application mobile est dans `~/isd-mobile`.

## Lancer en local

Prérequis : Node.js 20, Docker.

```bash
cp .env.example .env        # première fois seulement, puis adapter JWT_SECRET
npm install                 # première fois seulement
docker compose up -d        # démarre MongoDB (port 27017, local uniquement)
npm run seed                # comptes et offres de démonstration (base locale uniquement)
npm run dev                 # API sur http://localhost:5000 (redémarre à chaque modification)
```

Arrêter la base : `docker compose stop` (les données sont conservées).

### Comptes de démonstration

Mot de passe commun : `Demo1234`

| Rôle | Email |
|---|---|
| Famille | famille@demo.isd |
| Nounou | aya.nounou@demo.isd, fatou.nounou@demo.isd |
| Répétiteur | jeanmarc.repetiteur@demo.isd, koffi.repetiteur@demo.isd |

`npm run seed` refuse de s'exécuter si `MONGO_URI` ne pointe pas vers une base locale,
et ne supprime jamais de données (il met à jour les comptes de démo par email).

## Tests

```bash
npm test
```

Les tests n'utilisent pas de base de données (modèles Mongoose simulés).
