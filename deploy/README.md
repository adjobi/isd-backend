# Mettre ISD en ligne

Tout tourne sur **un seul serveur** : le site web, l'API, la base de données,
le certificat HTTPS (automatique et gratuit) et une sauvegarde quotidienne.

```
Internet ──HTTPS──▶ Caddy ──┬── /            → site (application exportée)
                            └── /api, /socket.io → API Node ──▶ MongoDB (non exposée)
                                                     sauvegarde quotidienne → deploy/backups
```

## Ce qu'il vous faut

| | Conseil | Coût indicatif |
|---|---|---|
| Serveur (VPS) | Ubuntu 24.04, 2 Go de RAM minimum (ex. Hetzner CX22, OVH VPS-1) | 4 à 7 €/mois |
| Nom de domaine | `.com` chez n'importe quel registrar, ou `.ci` chez un revendeur agréé NIC.ci | 10 à 30 €/an |
| Un email | pour le certificat HTTPS (avis d'expiration) | — |

## 1. Pointer le domaine vers le serveur

Chez votre registrar, dans la zone DNS, créez deux enregistrements **A** vers l'adresse IP du serveur :

| Type | Nom | Valeur |
|---|---|---|
| A | `@` | IP du serveur |
| A | `www` | IP du serveur |

La propagation prend de quelques minutes à quelques heures. Vérifiez avec `ping votre-domaine.com`.

## 2. Récupérer le code sur le serveur

Connectez-vous en SSH (`ssh root@IP_DU_SERVEUR`), puis :

```bash
mkdir -p /opt/isd && cd /opt/isd
git clone https://github.com/adjobi/isd-backend.git
git clone https://github.com/adjobi/isd-mobile.git
```

Si les dépôts sont **privés** : créez une clé sur le serveur (`ssh-keygen -t ed25519`),
ajoutez `~/.ssh/id_ed25519.pub` dans GitHub → dépôt → *Settings → Deploy keys* (lecture seule)
pour chacun des deux dépôts, puis clonez avec `git@github.com:adjobi/isd-backend.git`.

Les deux dossiers doivent être côte à côte : `/opt/isd/isd-backend` et `/opt/isd/isd-mobile`.

## 3. Installer

```bash
cd /opt/isd/isd-backend/deploy
sudo ./install.sh
```

Le script demande le domaine, l'email et le numéro Mobile Money d'ISD, puis :
- installe Docker, Git et le pare-feu (seuls SSH, HTTP et HTTPS restent ouverts) ;
- génère des secrets aléatoires dans `deploy/.env` (lisible par root uniquement) ;
- compile le site et démarre tout ; le certificat HTTPS est obtenu automatiquement.

À la fin : « OK : https://votre-domaine est en ligne. »

> **Gardez une copie de `deploy/.env` en lieu sûr** (gestionnaire de mots de passe).
> Sans `CHAT_ENCRYPTION_KEY`, les messages bloqués du chat d'une sauvegarde seraient illisibles.

## 4. Créer le compte administrateur

1. Sur le site, inscrivez-vous normalement avec l'adresse de l'équipe (ex. `equipe@votre-domaine.com`),
   de préférence **différente de votre compte personnel**.
2. Sur le serveur, donnez-lui les droits :
   ```bash
   cd /opt/isd/isd-backend/deploy
   sudo docker compose exec api node scripts/make-admin.js equipe@votre-domaine.com --production
   ```
3. Sur le site : accueil → « Équipe ISD » → connexion.

Retirer les droits : même commande avec `--remove`.
Les données de démonstration (`npm run seed`) **ne peuvent pas** être chargées en production : le script le refuse.

## Au quotidien

| Je veux… | Commande (dans `/opt/isd/isd-backend/deploy`) |
|---|---|
| Publier les dernières modifications | `sudo ./update.sh` |
| Voir si tout tourne | `sudo docker compose ps` |
| Lire les journaux | `sudo docker compose logs --tail=100 api` |
| Redémarrer l'API | `sudo docker compose restart api` |
| Lister les sauvegardes | `ls -lh backups/` |
| Restaurer une sauvegarde | `sudo ./restore.sh backups/isd-AAAA-MM-JJ_HHMM.archive.gz` |

**Sauvegardes** : une par jour, 14 jours conservés, dans `deploy/backups`.
Copiez-les régulièrement **hors du serveur** (si le serveur disparaît, elles aussi) :
```bash
scp root@IP_DU_SERVEUR:/opt/isd/isd-backend/deploy/backups/*.gz ./sauvegardes-isd/
```

## Sécurité en place

- HTTPS obligatoire (redirection automatique), en-têtes de sécurité (HSTS, anti-iframe…).
- Base de données non exposée sur Internet, protégée par mot de passe.
- Connexion : 5 échecs par compte → blocage 15 min ; 30 tentatives par connexion Internet / 15 min ;
  10 inscriptions par heure et par connexion ; message d'erreur unique (n'indique pas si l'email existe).
- Espace ISD : session de 12 h, droits relus en base à chaque action, journal de toutes les actions
  (paiements confirmés ou refusés, tarifs modifiés), visible dans l'onglet *Tarifs*.
- Le serveur refuse de démarrer si la configuration est dangereuse (clé secrète courte, CORS ouvert…).

## Paiement automatique CinetPay (plus tard)

Quand ISD aura un compte CinetPay (entreprise enregistrée), ajoutez dans `deploy/.env` :
```
CINETPAY_APIKEY=...
CINETPAY_SITE_ID=...
```
puis `sudo docker compose up -d`. L'adresse de notification est automatiquement
`https://votre-domaine/api/payments/cinetpay/notify`.

## En cas de problème

- **« Le site ne répond pas encore »** : le DNS n'est peut-être pas encore propagé (le certificat
  HTTPS ne peut pas être obtenu avant). Vérifiez `sudo docker compose logs caddy`, attendez, relancez `sudo ./update.sh --no-pull`.
- **« Configuration : … » dans les journaux de l'API** : une valeur de `deploy/.env` manque ou est invalide.
- **Compilation du site interrompue (mémoire)** : le serveur a moins de 2 Go ; `install.sh` ajoute 2 Go d'échange, vérifiez avec `free -h`.
