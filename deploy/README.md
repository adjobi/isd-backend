# Mettre ISD en ligne

Tout tourne sur **un seul serveur** : le site web, l'API, la base de données,
le certificat HTTPS (automatique et gratuit) et une sauvegarde quotidienne.

```
Internet ──HTTPS──▶ Caddy ──┬── /            → site vitrine (pages statiques : accueil, communes, FAQ)
                            ├── /app/        → application web (Expo exportée)
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

**Avant tout, installez votre clé SSH** : à la commande du serveur, ajoutez votre clé publique dans
l'interface de l'hébergeur (Hetzner : *Security → SSH keys*). Pas encore de clé ? Sur votre ordinateur :
`ssh-keygen -t ed25519`, puis copiez le contenu de `~/.ssh/id_ed25519.pub`. Grâce à elle, `install.sh`
interdit la connexion par mot de passe : personne ne pourra deviner l'accès au serveur.

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
- sécurise le serveur (`harden.sh`, relançable) : mises à jour de sécurité automatiques, blocage des
  adresses qui ratent 5 connexions SSH (fail2ban), connexion SSH par clé uniquement si une clé est installée ;
- programme chaque nuit la copie chiffrée des sauvegardes hors du serveur (à configurer, voir plus bas) ;
- génère des secrets aléatoires dans `deploy/.env` (lisible par root uniquement) ;
- compile le site et démarre tout ; le certificat HTTPS est obtenu automatiquement.

À la fin : « OK : https://votre-domaine est en ligne. »

> **Gardez une copie de `deploy/.env` en lieu sûr** (gestionnaire de mots de passe).
> Sans `CHAT_ENCRYPTION_KEY`, les messages bloqués du chat d'une sauvegarde seraient illisibles.
> `IDENTITY_ENCRYPTION_KEY` (distincte) chiffre les photos de vérification d'identité, gardées 30 jours au plus.

## 4. Créer le compte administrateur

1. Sur l'application (`https://votre-domaine/app/`), inscrivez-vous normalement avec l'adresse de l'équipe (ex. `equipe@votre-domaine.com`),
   de préférence **différente de votre compte personnel**.
2. Sur le serveur, donnez-lui les droits :
   ```bash
   cd /opt/isd/isd-backend/deploy
   sudo docker compose exec api node scripts/make-admin.js equipe@votre-domaine.com --production
   ```
3. Sur l'application (`/app/`) : accueil → « Équipe ISD » → connexion.
4. **Activez la double authentification** (obligatoire en ligne : l'Espace ISD reste fermé sans elle).
   Installez Google Authenticator ou Microsoft Authenticator sur votre téléphone, puis suivez l'écran
   « Sécurité du compte » : QR code, code à 6 chiffres, puis **10 codes de secours à noter sur papier**.
   Ensuite, chaque connexion demande le mot de passe et le code du téléphone.

Téléphone perdu **et** codes de secours perdus : après avoir vérifié l'identité de la personne,
`sudo docker compose exec api node scripts/reset-2fa.js equipe@votre-domaine.com --production`,
puis elle la réactive depuis l'app.

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
| Restaurer une sauvegarde | `sudo ./restore.sh backups/isd-AAAA-MM-JJ_HHMM.archive.gz` (purge ensuite les photos d'identité périmées) |
| Voir les copies hors serveur | `sudo ./offsite.sh --list` |
| Rapatrier une copie hors serveur | `sudo ./offsite.sh --get isd-AAAA-MM-JJ_HHMM.archive.gz.enc` |
| Vérifier la dernière copie hors serveur | `tail -3 /var/log/isd-offsite.log` |
| Re-sécuriser le serveur (après ajout d'une clé SSH) | `sudo ./harden.sh` |

**Sauvegardes** : une par jour, 14 jours conservés sur le serveur, dans `deploy/backups`.

### Copie hors du serveur (à faire une fois)

Si le serveur est perdu, ses sauvegardes le sont aussi. Chaque nuit à 4 h 30, `offsite.sh` chiffre
les nouvelles sauvegardes (AES-256, phrase `BACKUP_PASSPHRASE` de `deploy/.env`) et les envoie sur un
stockage externe ; 60 jours y sont conservés. Le stockage ne voit jamais les données en clair.

Stockage conseillé : **Hetzner Storage Box BX11** (1 To, environ 4 €/mois, autre centre de données).
1. Commandez-la, activez *SSH support* et notez l'adresse (`uXXXXX.your-storagebox.de`), l'utilisateur et le mot de passe.
2. Sur le serveur : `sudo rclone config` → `n` (nouveau) → nom `isd-offsite` → type `sftp` →
   hôte `uXXXXX.your-storagebox.de`, utilisateur `uXXXXX`, port `23`, mot de passe → valeurs par défaut pour le reste.
3. `sudo rclone mkdir isd-offsite:sauvegardes-isd`
4. Dans `deploy/.env` : `BACKUP_REMOTE=isd-offsite:sauvegardes-isd`
5. Test immédiat : `sudo ./offsite.sh` puis `sudo ./offsite.sh --list`.

Tout autre stockage reconnu par rclone fonctionne (Backblaze B2, Google Drive…).
**La phrase `BACKUP_PASSPHRASE` est indispensable pour relire ces copies** : elle est dans `deploy/.env`,
dont vous gardez une copie en lieu sûr.

## Sécurité en place

- HTTPS obligatoire (redirection automatique), en-têtes de sécurité (HSTS, anti-iframe…).
- Politique de sécurité du contenu (CSP) : le navigateur n'exécute que les scripts du site lui-même ;
  un script injecté ou une connexion vers un autre site est bloqué.
- Serveur : pare-feu, SSH par clé uniquement, fail2ban, mises à jour de sécurité automatiques.
- Base de données non exposée sur Internet, protégée par mot de passe ; sauvegardes quotidiennes,
  copiées chiffrées hors du serveur.
- Espace ISD : double authentification obligatoire (code du téléphone ou code de secours à usage unique).
- Connexion : 5 échecs par compte → blocage 15 min ; 30 tentatives par connexion Internet / 15 min ;
  10 inscriptions par heure et par connexion ; message d'erreur unique (n'indique pas si l'email existe).
- Espace ISD : session de 12 h, droits relus en base à chaque action, journal de toutes les actions
  (paiements confirmés ou refusés, tarifs, avis, double authentification), visible dans l'onglet *Tarifs*.
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

## Le site vitrine et Google

Le site vitrine (`isd-mobile/vitrine`) est régénéré à chaque `update.sh` : accueil, une page par
commune pour les nounous et les répétiteurs, questions fréquentes, `sitemap.xml` et `robots.txt`.
Après la mise en ligne, déclarez le site dans **Google Search Console** (gratuit) et envoyez
`https://votre-domaine/sitemap.xml` : les pages « Nounou à Cocody », « Répétiteur à Yopougon »…
pourront alors apparaître dans les recherches Google.

**Avant d'ouvrir au public**, complétez `isd-mobile/vitrine/legal.json` (raison sociale, RCCM, adresse,
email, hébergeur, déclaration ARTCI…), faites relire les trois pages légales par un juriste, puis passez
`"valide": true` et relancez `update.sh` : le bandeau « Brouillon » disparaît et les pages entrent dans le
plan du site. Pour afficher le bouton WhatsApp, renseignez `WHATSAPP_ISD` dans `deploy/.env` (ex. `2250700000000`).
