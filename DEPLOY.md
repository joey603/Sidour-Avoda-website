# Backend Deployment (Oracle / Ubuntu)

Ce guide explique comment mettre a jour le backend de production pour qu'il corresponde
au code pousse sur `main`.

## Déploiement automatique (GitHub Actions)

À chaque **push sur `main`** qui touche `backend/**` ou `deploy/oracle/**`, le workflow
[`.github/workflows/deploy-oracle-backend.yml`](.github/workflows/deploy-oracle-backend.yml) :

1. se connecte en SSH à Oracle
2. lance [`deploy/oracle/deploy-backend.sh`](deploy/oracle/deploy-backend.sh) (`git pull` + pip + restart forcé)
3. vérifie `GET /health`

Déclenchement manuel : onglet Actions → **Deploy Oracle backend** → Run workflow.

Secret repo requis (`Settings → Secrets and variables → Actions`) :

| Secret | Valeur |
|--------|--------|
| `ORACLE_SSH_PRIVATE_KEY` | contenu de la clé privée SSH Oracle |

(`host` / `user` sont dans le workflow, pas des secrets.)

```bash
# Depuis le Mac (une fois)
gh secret set ORACLE_SSH_PRIVATE_KEY -R joey603/Sidour-Avoda-website < /Users/yoelibarthel/Downloads/ssh-key-2026-04-08.key
```

Si l’IDE affiche encore « Context access might be invalid: ORACLE_SSH_PRIVATE_KEY », c’est un faux positif de l’extension GitHub Actions : le secret existe bien et le workflow tourne.

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

## Déploiement manuel (secours)

Sur le serveur :

```bash
/home/ubuntu/deploy-backend.sh
```

Le script source de vérité est [`deploy/oracle/deploy-backend.sh`](deploy/oracle/deploy-backend.sh)
(copié vers `/home/ubuntu/deploy-backend.sh` à chaque deploy).

## Verifier que le backend fonctionne

```bash
sudo systemctl status sidour-backend --no-pager
sudo journalctl -u sidour-backend -n 50 --no-pager
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/docs
```

Si `sidour-backend` est `active (running)` et que `/health` repond, le backend de production
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
