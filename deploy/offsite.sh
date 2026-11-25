#!/usr/bin/env bash
# Copie chiffrée des sauvegardes HORS du serveur (lancé chaque nuit par cron, installé par install.sh).
# - chaque sauvegarde de deploy/backups est chiffrée (AES-256, phrase BACKUP_PASSPHRASE de deploy/.env)
#   puis envoyée vers BACKUP_REMOTE (un stockage configuré avec « rclone config » : Hetzner Storage Box,
#   Backblaze B2, Google Drive…). Le stockage ne voit jamais les données en clair.
# - les copies de plus de BACKUP_KEEP_DAYS jours (60 par défaut) sont supprimées du stockage.
# Usage :
#   sudo ./offsite.sh            envoie les nouvelles sauvegardes
#   sudo ./offsite.sh --list     liste les copies présentes sur le stockage
#   sudo ./offsite.sh --get NOM  rapatrie une copie dans deploy/backups (puis : sudo ./restore.sh backups/NOM)
set -euo pipefail
cd "$(dirname "$0")"

env_value() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }
REMOTE="${BACKUP_REMOTE:-$(env_value BACKUP_REMOTE)}"
BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:-$(env_value BACKUP_PASSPHRASE)}"
KEEP="${BACKUP_KEEP_DAYS:-$(env_value BACKUP_KEEP_DAYS)}"
KEEP="${KEEP:-60}"
export BACKUP_PASSPHRASE

if [ -z "$REMOTE" ]; then
  echo "$(date '+%F %T') copie hors serveur non configurée : renseignez BACKUP_REMOTE dans deploy/.env (voir README)."
  exit 0
fi
if [ "${#BACKUP_PASSPHRASE}" -lt 32 ]; then
  echo "$(date '+%F %T') ÉCHEC : BACKUP_PASSPHRASE absente ou trop courte dans deploy/.env"
  exit 1
fi
command -v rclone >/dev/null || { echo "ÉCHEC : rclone n'est pas installé (sudo apt install rclone)"; exit 1; }

case "${1:-}" in
  --list)
    rclone lsl "$REMOTE" --include 'isd-*.enc'
    exit 0 ;;
  --get)
    NAME="$(basename "${2:-}")"
    case "$NAME" in isd-*.archive.gz.enc) ;; *) echo "Usage : sudo ./offsite.sh --get isd-AAAA-MM-JJ_HHMM.archive.gz.enc"; exit 1 ;; esac
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    rclone copyto "$REMOTE/$NAME" "$tmp/$NAME"
    out="backups/${NAME%.enc}"
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$tmp/$NAME" -out "$out"
    gzip -t "$out"
    echo "Copie rapatriée et déchiffrée : $out"
    echo "Pour la restaurer : sudo ./restore.sh $out"
    exit 0 ;;
esac

# Envoi des sauvegardes pas encore présentes sur le stockage.
sent=0; failed=0
existing="$(rclone lsf "$REMOTE" --include 'isd-*.enc' 2>/dev/null || true)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# Fichiers de plus de 10 minutes seulement : jamais une sauvegarde en cours d'écriture.
for f in $(find backups -maxdepth 1 -name 'isd-*.archive.gz' -mmin +10 | sort); do
  name="$(basename "$f").enc"
  grep -qxF "$name" <<<"$existing" && continue
  if openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -in "$f" -out "$tmp/$name" \
     && rclone copyto "$tmp/$name" "$REMOTE/$name"; then
    sent=$((sent + 1))
  else
    failed=$((failed + 1)); echo "$(date '+%F %T') ÉCHEC de l'envoi : $name"
  fi
  rm -f "$tmp/$name"
done
rclone delete "$REMOTE" --include 'isd-*.enc' --min-age "${KEEP}d" 2>/dev/null || true
echo "$(date '+%F %T') copie hors serveur : $sent envoyée(s), $failed échec(s), copies de plus de $KEEP jours supprimées"
[ "$failed" -eq 0 ]
