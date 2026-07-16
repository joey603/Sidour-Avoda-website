#!/usr/bin/env bash
# Déploiement backend Oracle — versionnée dans le repo.
# Utilisé manuellement et par GitHub Actions (SSH).
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/ubuntu/Sidour-Avoda-website}"
BACKEND_DIR="$PROJECT_DIR/backend"
VENV_DIR="$BACKEND_DIR/.venv"
BRANCH="${BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-sidour-backend}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8000/health}"

echo "==> Déploiement backend"
cd "$PROJECT_DIR"

echo "==> Git fetch"
git fetch origin

echo "==> Checkout $BRANCH"
git checkout "$BRANCH"

echo "==> Pull latest"
git pull --ff-only origin "$BRANCH"

# Resynchroniser ce script vers ~/ si on vient du repo
if [[ -f "$PROJECT_DIR/deploy/oracle/deploy-backend.sh" ]]; then
  install -m 0755 "$PROJECT_DIR/deploy/oracle/deploy-backend.sh" /home/ubuntu/deploy-backend.sh
fi
if [[ -f "$PROJECT_DIR/deploy/oracle/watchdog-backend.sh" ]]; then
  install -m 0755 "$PROJECT_DIR/deploy/oracle/watchdog-backend.sh" /home/ubuntu/watchdog-backend.sh
fi

echo "==> Activer venv"
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

echo "==> Installer dépendances"
pip install -r "$BACKEND_DIR/requirements.txt"

echo "==> Vérification syntaxe Python"
python3 -m py_compile \
  "$BACKEND_DIR/app/main.py" \
  "$BACKEND_DIR/app/sites.py" \
  "$BACKEND_DIR/app/schemas.py" \
  "$BACKEND_DIR/app/models.py"

echo "==> Restart forcé $SERVICE_NAME"
# Évite le hang de systemctl restart si uvicorn est gelé
sudo systemctl kill -s SIGKILL "$SERVICE_NAME" 2>/dev/null || true
sleep 1
sudo systemctl reset-failed "$SERVICE_NAME" 2>/dev/null || true
sudo systemctl start "$SERVICE_NAME"

echo "==> Attente health"
ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf --connect-timeout 3 --max-time 5 "$HEALTH_URL" >/dev/null; then
    ok=1
    echo "health OK (tentative $i)"
    break
  fi
  sleep 2
done
if [[ "$ok" -ne 1 ]]; then
  echo "ECHEC: /health ne répond pas après restart" >&2
  sudo systemctl --no-pager --full status "$SERVICE_NAME" || true
  sudo journalctl -u "$SERVICE_NAME" -n 40 --no-pager || true
  exit 1
fi

echo "==> Status service"
sudo systemctl --no-pager --full status "$SERVICE_NAME" | head -25

echo "==> Commit déployé: $(git rev-parse --short HEAD)"
echo "==> Déploiement terminé"
