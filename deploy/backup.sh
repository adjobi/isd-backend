#!/bin/sh
# Sauvegarde quotidienne de la base ISD (lancé par le service « backup » de docker-compose).
# Une archive par jour dans deploy/backups ; celles de plus de 14 jours sont supprimées.
while true; do
  f="/backups/isd-$(date +%Y-%m-%d_%H%M).archive.gz"
  if mongodump --uri="$MONGO_URI" --archive="$f" --gzip --quiet; then
    echo "sauvegarde OK : $f"
  else
    echo "ÉCHEC de la sauvegarde ($(date))"
  fi
  find /backups -name 'isd-*.archive.gz' -mtime +14 -delete
  sleep 86400
done
