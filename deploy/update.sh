#!/usr/bin/env bash
# Met ISD à jour sur le serveur : récupère le code, recompile le site, redémarre l'API.
# Usage (depuis le dossier deploy) :  sudo ./update.sh          (avec git pull)
#                                     sudo ./update.sh --no-pull (code déjà à jour)
# Les données (base, sauvegardes, certificats) ne sont jamais touchées.
set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
MOBILE_DIR="${MOBILE_DIR:-$(cd "$BACKEND_DIR/.." && pwd)/isd-mobile}"
cd "$DEPLOY_DIR"

if [ ! -f .env ]; then echo "deploy/.env manquant : lancez d'abord install.sh"; exit 1; fi
DOMAIN="$(grep '^DOMAIN=' .env | cut -d= -f2-)"
if [ -z "$DOMAIN" ]; then echo "DOMAIN manquant dans deploy/.env"; exit 1; fi
if [ ! -d "$MOBILE_DIR" ]; then echo "Application introuvable : $MOBILE_DIR (clonez isd-mobile à côté d'isd-backend)"; exit 1; fi

if [ "${1:-}" != "--no-pull" ]; then
  echo "== Récupération du code"
  git -C "$BACKEND_DIR" pull --ff-only
  git -C "$MOBILE_DIR" pull --ff-only
fi

echo "== Compilation du site pour https://$DOMAIN (quelques minutes)"
mkdir -p site site.new
docker run --rm \
  -v "$MOBILE_DIR":/app -v "$DEPLOY_DIR/site.new":/out -w /app \
  -e EXPO_PUBLIC_API_URL="https://$DOMAIN" -e CI=1 \
  node:20 sh -c "npm ci --no-audit --no-fund && npx expo export -p web --clear --output-dir /out"
# Remplacement du site en une fois (le serveur web lit le même dossier).
rsync -a --delete site.new/ site/

echo "== Démarrage / mise à jour des services"
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null

echo "== Vérification"
for i in $(seq 1 30); do
  if curl -fsS "https://$DOMAIN/api/health" >/dev/null 2>&1; then
    echo "OK : https://$DOMAIN est en ligne."
    exit 0
  fi
  sleep 5
done
echo "Le site ne répond pas encore. Consultez les journaux : docker compose logs --tail=50 api caddy"
exit 1
