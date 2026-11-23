# ISD Backend — Node.js / Express / MongoDB

API de la plateforme ISD (familles, nounous, répétiteurs).
L'application mobile est dans ~/isd-mobile (React Native / Expo).

## Modèles existants
- Nanny.js : champs dont hourlyRate, rating, experienceYears
- Offer.js : serviceType enum "nanny" | "tutor"

## Règles de code
- Valider toutes les entrées côté serveur ; ne jamais faire confiance au client
- Mots de passe toujours chiffrés (bcrypt) ; ne jamais les renvoyer dans une réponse
- Contacts des prestataires (téléphone, email) masqués dans toutes les réponses d'API
  tant que la facture ISD n'est pas payée
- Réponses d'erreur cohérentes (code HTTP + message en français)
- Aucun secret en dur : variables d'environnement (.env, ignoré par Git)

## Règles métier (cahier des charges)
- Offre famille : description, durée (longue / courte), prix proposé, matière (répétiteurs)
- Prestataire : photo, tarif, statut (disponible, occupé, en congé, vacances)
- Candidature acceptée par une famille => refus automatique des autres candidatures de l'offre
- Candidature validée => ouverture d'un chat à 3 (famille, prestataire, système ISD)
  avec filtrage des coordonnées (téléphone, email, Facebook, Messenger)
- Facture = un mois de salaire du prestataire, payée à ISD par mobile money ;
  les coordonnées ne sont échangées qu'après paiement
- Compte système ISD : assistante commerciale virtuelle (module IA)

## Feuille de route
1. Accueil, inscription, connexion, rôles
2. Offres
3. Candidatures
4. Chat temps réel (Socket.io)
5. Paiement mobile money et contrat

## Workflow
- Proposer un plan court avant de coder, puis attendre validation
- Chaque route nouvelle ou modifiée : au moins un test
- Avant de conclure : lancer les tests et vérifier que le serveur démarre
- Ne jamais supprimer de données ni lancer de migration sans accord explicite
