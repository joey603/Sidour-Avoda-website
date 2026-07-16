#!/usr/bin/env bash
# Installe / met à jour le watchdog sur la machine Oracle (à lancer sur le serveur).
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/ubuntu/Sidour-Avoda-website}"
SCRIPT_SRC="$PROJECT_DIR/deploy/oracle/watchdog-backend.sh"

if [[ ! -f "$SCRIPT_SRC" ]]; then
  echo "Fichier manquant: $SCRIPT_SRC (git pull d'abord)" >&2
  exit 1
fi

sudo mkdir -p /var/lib/sidour
sudo chown ubuntu:ubuntu /var/lib/sidour
sudo touch /var/log/sidour-backend-watchdog.log
sudo chown ubuntu:ubuntu /var/log/sidour-backend-watchdog.log

install -m 0755 "$SCRIPT_SRC" /home/ubuntu/watchdog-backend.sh
sudo install -m 0644 "$PROJECT_DIR/deploy/oracle/sidour-watchdog.service" /etc/systemd/system/sidour-watchdog.service
sudo install -m 0644 "$PROJECT_DIR/deploy/oracle/sidour-watchdog.timer" /etc/systemd/system/sidour-watchdog.timer

sudo mkdir -p /etc/systemd/system/sidour-backend.service.d
sudo tee /etc/systemd/system/sidour-backend.service.d/override.conf >/dev/null <<'EOF'
[Service]
TimeoutStopSec=10
KillMode=mixed
KillSignal=SIGTERM
FinalKillSignal=SIGKILL
EOF

# Retirer l’ancien cron keep-alive / watchdog horaire
if crontab -l >/tmp/sidour-cron.bak 2>/dev/null; then
  grep -v 'keep-alive-backend.sh' /tmp/sidour-cron.bak | grep -v 'watchdog-backend.sh' | crontab - || true
  rm -f /tmp/sidour-cron.bak
fi

sudo systemctl daemon-reload
sudo systemctl enable --now sidour-watchdog.timer
sudo systemctl start sidour-watchdog.service || true

echo "==> Timer"
systemctl list-timers sidour-watchdog.timer --no-pager || true
echo "==> Status JSON"
cat /var/lib/sidour/watchdog-status.json 2>/dev/null || echo "(pas encore écrit)"
echo "==> Log"
tail -n 10 /var/log/sidour-backend-watchdog.log 2>/dev/null || true
echo "==> Install watchdog terminé"
