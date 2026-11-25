#!/usr/bin/env bash
# Sécurisation du serveur (lancé par install.sh ; peut être relancé sans risque) :
# - mises à jour de sécurité d'Ubuntu installées automatiquement chaque jour
# - fail2ban : une adresse qui rate 5 connexions SSH en 10 min est bloquée (1 h, puis plus longtemps)
# - SSH par clé uniquement (mot de passe refusé), SEULEMENT si une clé SSH est déjà installée :
#   sinon on n'y touche pas, pour ne jamais vous enfermer dehors.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Lancez ce script avec sudo : sudo ./harden.sh"
  exit 1
fi

apt-get install -y -qq unattended-upgrades fail2ban python3-systemd >/dev/null

# Mises à jour de sécurité automatiques (redémarrage jamais automatique : à faire à un moment calme).
printf '%s\n' \
  'APT::Periodic::Update-Package-Lists "1";' \
  'APT::Periodic::Unattended-Upgrade "1";' \
  'APT::Periodic::AutocleanInterval "7";' > /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
echo "   mises à jour de sécurité automatiques : activées"

# fail2ban sur SSH.
printf '%s\n' \
  '[sshd]' \
  'enabled = true' \
  'backend = systemd' \
  'maxretry = 5' \
  'findtime = 10m' \
  'bantime = 1h' \
  'bantime.increment = true' \
  'bantime.maxtime = 1w' > /etc/fail2ban/jail.d/isd.local
systemctl enable fail2ban >/dev/null 2>&1
systemctl restart fail2ban
echo "   fail2ban (SSH) : activé"

# SSH par clé uniquement, si au moins une clé est installée (root ou un utilisateur).
has_key=0
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  [ -f "$f" ] && grep -qE '^(ssh-|ecdsa-|sk-)' "$f" && has_key=1
done
conf=/etc/ssh/sshd_config.d/10-isd.conf
if [ "$has_key" -eq 1 ]; then
  # Le fichier « 10- » est lu avant ceux de l'hébergeur (50-cloud-init…) : ses réglages l'emportent.
  printf '%s\n' \
    '# ISD : connexion SSH par clé uniquement.' \
    'PasswordAuthentication no' \
    'KbdInteractiveAuthentication no' \
    'PermitRootLogin prohibit-password' \
    'MaxAuthTries 3' \
    'X11Forwarding no' > "$conf"
  if sshd -t; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd
    echo "   SSH : clé obligatoire, mot de passe refusé"
  else
    rm -f "$conf"
    echo "   ATTENTION : configuration SSH refusée par sshd, rien n'a été changé."
  fi
else
  echo "   ATTENTION : aucune clé SSH installée sur ce serveur."
  echo "   La connexion par mot de passe reste possible. Ajoutez votre clé (voir README), puis relancez : sudo ./harden.sh"
fi
