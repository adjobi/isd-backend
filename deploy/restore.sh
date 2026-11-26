#!/usr/bin/env bash
# Restaure la base ISD depuis une sauvegarde de deploy/backups.
# ATTENTION : remplace toutes les données actuelles par celles de la sauvegarde.
# Usage :  sudo ./restore.sh backups/isd-2026-12-01_0300.archive.gz
set -euo pipefail
cd "$(dirname "$0")"
FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "Usage : sudo ./restore.sh backups/isd-AAAA-MM-JJ_HHMM.archive.gz"
  echo "Sauvegardes disponibles :"; ls -1t backups/ 2>/dev/null | head -20
  exit 1
fi
echo "Cette opération REMPLACE toute la base actuelle par : $FILE"
read -rp "Tapez RESTAURER pour confirmer : " ok
[ "$ok" = "RESTAURER" ] || { echo "Annulé."; exit 1; }

NAME="$(basename "$FILE")"
docker compose exec -T backup sh -c "mongorestore --uri=\"\$MONGO_URI\" --archive=/backups/$NAME --gzip --drop --nsInclude='isd.*'"
echo "Restauration terminée. Redémarrage de l'API…"
docker compose restart api

# Une sauvegarde peut contenir des photos de vérification d'identité depuis supprimées :
# on réapplique tout de suite la règle de rétention (demandes décidées ou expirées → photos effacées).
echo "Purge des photos de vérification d'identité…"
for i in 1 2 3 4 5 6; do
  if docker compose exec -T api node scripts/purge-identity.js --production; then break; fi
  if [ "$i" = 6 ]; then
    echo "⚠️  Purge non effectuée : relancez  docker compose exec -T api node scripts/purge-identity.js --production"
    exit 1
  fi
  sleep 10
done
