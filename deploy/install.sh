#!/usr/bin/env bash
# Première installation d'ISD sur un serveur Ubuntu (22.04 ou 24.04) neuf.
# À lancer depuis le dossier deploy :  sudo ./install.sh
# - installe Docker, Git, le pare-feu et un fichier d'échange (swap)
# - crée deploy/.env avec des secrets générés aléatoirement (une seule fois)
# - compile le site et démarre tous les services (via update.sh)
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
  echo "Lancez ce script avec sudo : sudo ./install.sh"
  exit 1
fi

echo "== 1/4 Logiciels (Docker, Git, pare-feu)"
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 git ufw rsync openssl curl >/dev/null
systemctl enable --now docker

echo "== 2/4 Pare-feu : seuls SSH, HTTP et HTTPS sont ouverts"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null

# La compilation du site demande de la mémoire : 2 Go d'échange sur les petits serveurs.
if ! swapon --show | grep -q .; then
  echo "   + fichier d'échange de 2 Go"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== 3/4 Configuration"
if [ -f .env ]; then
  echo "   deploy/.env existe déjà : conservé (secrets inchangés)."
else
  read -rp "   Nom de domaine du site (ex. isd-ci.com, sans www) : " DOMAIN
  read -rp "   Email de contact pour le certificat HTTPS : " ACME_EMAIL
  read -rp "   Numéro Mobile Money d'ISD (ex. +2250700000000) : " ISD_NUMBER
  read -rp "   Numéro WhatsApp d'ISD pour le site (ex. 2250700000000, vide pour aucun) : " WHATSAPP_ISD
  umask 077
  cat > .env <<EOF
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
ISD_MOBILE_MONEY_NUMBER=${ISD_NUMBER}
WHATSAPP_ISD=${WHATSAPP_ISD}
MONGO_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 64)
# Ne JAMAIS changer après la mise en ligne : les messages bloqués du chat deviendraient illisibles.
CHAT_ENCRYPTION_KEY=$(openssl rand -hex 32)
CINETPAY_APIKEY=
CINETPAY_SITE_ID=
EOF
  echo "   deploy/.env créé (lisible par root uniquement). Gardez-en une copie en lieu sûr."
fi
mkdir -p site backups

echo "== 4/4 Compilation du site et démarrage"
./update.sh --no-pull

echo
echo "Installation terminée. Étape suivante : créer le compte administrateur (voir README.md)."
