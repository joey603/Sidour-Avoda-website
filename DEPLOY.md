# Backend Deployment (Oracle / Ubuntu)

Ce guide explique comment mettre a jour le backend de production pour qu'il corresponde
au code pousse sur `main`.

## Serveur cible

- **IP (Oracle Cloud)** : `129.159.131.86`
- Connexion SSH depuis **ton Mac** (clé privée Oracle) — copie-colle toute la ligne :

```bash
ssh -i /Users/yoelibarthel/Downloads/ssh-key-2026-04-08.key ubuntu@129.159.131.86
```

*(Si SSH refuse la clé : `chmod 400 /Users/yoelibarthel/Downloads/ssh-key-2026-04-08.key`.)*

Une fois connecté **sur le serveur**, pour lancer le déploiement (après avoir créé le script une première fois, sections 1–2) :

```bash
/home/ubuntu/deploy-backend.sh
```

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

---

## A la fin (sur le serveur)

```bash
sudo systemctl status sidour-backend --no-pager
curl http://127.0.0.1:8000/docs
```

---

## Watchdog surcharge + redémarrage auto

Le timer systemd `sidour-watchdog` exécute toutes les **2 minutes** le script
[`deploy/oracle/watchdog-backend.sh`](deploy/oracle/watchdog-backend.sh) :

- sonde `GET /health` avec `--max-time 5` (évite les `curl` bloqués)
- mesure load / CPU uvicorn
- **restart forcé** (`SIGKILL` puis `start`) si health KO, service inactif, ou surcharge + latence
- anti-flapping : max 3 restarts / 30 min
- écrit `/var/lib/sidour/watchdog-status.json` (exposé dans `GET /health` → champ `watchdog`)
- log : `/var/log/sidour-backend-watchdog.log`

### Installer / mettre a jour le watchdog (sur Oracle)

Depuis le Mac (après `git push` du repo) :

```bash
ssh -i /Users/yoelibarthel/Downloads/ssh-key-2026-04-08.key ubuntu@129.159.131.86
```

Puis sur le serveur :

```bash
cd /home/ubuntu/Sidour-Avoda-website
git pull --ff-only origin main

sudo mkdir -p /var/lib/sidour
sudo chown ubuntu:ubuntu /var/lib/sidour
sudo touch /var/log/sidour-backend-watchdog.log
sudo chown ubuntu:ubuntu /var/log/sidour-backend-watchdog.log

install -m 0755 deploy/oracle/watchdog-backend.sh /home/ubuntu/watchdog-backend.sh
sudo install -m 0644 deploy/oracle/sidour-watchdog.service /etc/systemd/system/sidour-watchdog.service
sudo install -m 0644 deploy/oracle/sidour-watchdog.timer /etc/systemd/system/sidour-watchdog.timer

# Backend : arrêts plus rapides si uvicorn est gelé
sudo mkdir -p /etc/systemd/system/sidour-backend.service.d
echo '[Service]
TimeoutStopSec=10
KillMode=mixed
KillSignal=SIGTERM
FinalKillSignal=SIGKILL' | sudo tee /etc/systemd/system/sidour-backend.service.d/override.conf

# Retirer l’ancien cron (keep-alive sans max-time + watchdog horaire)
crontab -l 2>/dev/null | grep -v 'keep-alive-backend.sh' | grep -v 'watchdog-backend.sh' | crontab - || true

sudo systemctl daemon-reload
sudo systemctl enable --now sidour-watchdog.timer
sudo systemctl restart sidour-backend
sudo systemctl start sidour-watchdog.service
```

### Verifier

```bash
systemctl list-timers sidour-watchdog.timer --no-pager
cat /var/lib/sidour/watchdog-status.json
tail -n 20 /var/log/sidour-backend-watchdog.log
curl -sS http://127.0.0.1:8000/health
curl -sS https://129-159-131-86.sslip.io/health
```

Le champ `watchdog.state` vaut `ok`, `degraded`, `restarting` ou `down`.
