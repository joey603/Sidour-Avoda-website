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
# SKIP_GIT=1 si l’appelant a déjà fetch + reset (GitHub Actions).
SKIP_GIT="${SKIP_GIT:-0}"

echo "==> Déploiement backend"
cd "$PROJECT_DIR"

if [[ "$SKIP_GIT" != "1" ]]; then
  echo "==> Git fetch + reset origin/$BRANCH"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  # Production = origin. Évite le blocage si des fichiers ont été édités sur le serveur.
  git reset --hard "origin/$BRANCH"
else
  echo "==> Git déjà à jour (SKIP_GIT=1)"
fi

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

REQ_FILE="$BACKEND_DIR/requirements.txt"
REQ_STAMP="$VENV_DIR/.requirements.sha256"
REQ_HASH="$(sha256sum "$REQ_FILE" | awk '{print $1}')"
if [[ -f "$REQ_STAMP" && "$(cat "$REQ_STAMP")" == "$REQ_HASH" ]]; then
  echo "==> Dépendances inchangées — skip pip"
else
  echo "==> Installer dépendances"
  pip install --disable-pip-version-check --no-input -r "$REQ_FILE"
  printf '%s\n' "$REQ_HASH" > "$REQ_STAMP"
fi

echo "==> Vérification syntaxe Python"
python3 -m py_compile \
  "$BACKEND_DIR/app/main.py" \
  "$BACKEND_DIR/app/sites.py" \
  "$BACKEND_DIR/app/schemas.py" \
  "$BACKEND_DIR/app/models.py"

echo "==> Alembic upgrade (head) avec fallback stamp si schéma déjà présent"
cd "$BACKEND_DIR"
export SERVICE_NAME
python3 <<'PY'
import os, re, subprocess, sys

unit = subprocess.check_output(["sudo", "systemctl", "cat", os.environ.get("SERVICE_NAME", "sidour-backend")], text=True)
env = os.environ.copy()
for line in unit.splitlines():
    s = line.strip()
    if not s.startswith("Environment="):
        continue
    rest = s[len("Environment="):]
    if rest.startswith('"') and rest.endswith('"'):
        rest = rest[1:-1]
    if "=" not in rest:
        continue
    k, v = rest.split("=", 1)
    env[k] = v

if not env.get("DATABASE_URL"):
    print("WARN: DATABASE_URL absent du unit systemd — skip alembic pré-restart", file=sys.stderr)
    sys.exit(0)

def run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, env=env)

r = run([".venv/bin/alembic", "upgrade", "head"])
sys.stdout.write(r.stdout or "")
sys.stderr.write(r.stderr or "")
if r.returncode == 0:
    print("alembic: already at head or upgraded OK")
    sys.exit(0)

combined = f"{r.stdout}\n{r.stderr}".lower()
if "already exists" not in combined and "duplicate" not in combined:
    print("alembic upgrade failed", file=sys.stderr)
    sys.exit(r.returncode)

print("alembic: schema exists without version — stamp base then upgrade")
from alembic.config import Config
from alembic.script import ScriptDirectory

# Ensure env.py / Settings see DATABASE_URL
for k in ("DATABASE_URL", "JWT_SECRET"):
    if k in env:
        os.environ[k] = env[k]

cfg = Config("alembic.ini")
script = ScriptDirectory.from_config(cfg)
for base in script.get_bases() or []:
    r2 = run([".venv/bin/alembic", "stamp", base])
    sys.stdout.write(r2.stdout or "")
    sys.stderr.write(r2.stderr or "")
    if r2.returncode != 0:
        sys.exit(r2.returncode)
r3 = run([".venv/bin/alembic", "upgrade", "head"])
sys.stdout.write(r3.stdout or "")
sys.stderr.write(r3.stderr or "")
sys.exit(r3.returncode)
PY

echo "==> Restart forcé $SERVICE_NAME"
# Évite le hang de systemctl restart si uvicorn est gelé
sudo systemctl kill -s SIGKILL "$SERVICE_NAME" 2>/dev/null || true
sleep 0.5
sudo systemctl reset-failed "$SERVICE_NAME" 2>/dev/null || true
sudo systemctl start "$SERVICE_NAME"

echo "==> Attente health"
ok=0
for i in $(seq 1 20); do
  if curl -sf --connect-timeout 1 --max-time 3 "$HEALTH_URL" >/dev/null; then
    ok=1
    echo "health OK (tentative $i)"
    break
  fi
  sleep 0.5
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
