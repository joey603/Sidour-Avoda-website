# Backend Deployment (Oracle / Ubuntu)

Ce guide explique comment mettre a jour le backend de production pour qu'il corresponde
au code pousse sur `main`.

## Serveur cible

- Projet : `/home/ubuntu/Sidour-Avoda-website`
- Backend : `/home/ubuntu/Sidour-Avoda-website/backend`
- Venv : `/home/ubuntu/Sidour-Avoda-website/backend/.venv`
- Service systemd : `sidour-backend`

## 1. Creer le script de deploiement

Sur le serveur Oracle :

```bash
nano /home/ubuntu/deploy-backend.sh
```

Colle ce contenu :

```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/ubuntu/Sidour-Avoda-website"
BACKEND_DIR="$PROJECT_DIR/backend"
VENV_DIR="$BACKEND_DIR/.venv"
BRANCH="main"
SERVICE_NAME="sidour-backend"

echo "==> Deploiement backend"
cd "$PROJECT_DIR"

echo "==> Git fetch"
git fetch origin

echo "==> Checkout $BRANCH"
git checkout "$BRANCH"

echo "==> Pull latest"
git pull --ff-only origin "$BRANCH"

echo "==> Activer venv"
source "$VENV_DIR/bin/activate"

echo "==> Installer dependances"
pip install -r "$BACKEND_DIR/requirements.txt"

echo "==> Verification syntaxe Python"
python3 -m py_compile "$BACKEND_DIR/app/main.py" "$BACKEND_DIR/app/sites.py" "$BACKEND_DIR/app/schemas.py" "$BACKEND_DIR/app/models.py"

echo "==> Restart service $SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo "==> Status service"
sudo systemctl --no-pager --full status "$SERVICE_NAME"

echo "==> Derniers logs"
sudo journalctl -u "$SERVICE_NAME" -n 50 --no-pager

echo "==> Deploiement termine"
```

## 2. Rendre le script executable

```bash
chmod +x /home/ubuntu/deploy-backend.sh
```

## 3. Lancer le script

```bash
/home/ubuntu/deploy-backend.sh
```

## 4. Verifier que le backend fonctionne

```bash
sudo systemctl status sidour-backend --no-pager
sudo journalctl -u sidour-backend -n 50 --no-pager
curl http://127.0.0.1:8000/docs
```

Si `sidour-backend` est `active (running)` et que `/docs` repond, le backend de production
correspond bien au code pousse.
