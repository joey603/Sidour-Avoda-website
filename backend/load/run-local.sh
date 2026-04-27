#!/usr/bin/env bash
# Tests de charge 100 % locaux.
#
# Usage :
#   bash load/run-local.sh          → interface web http://localhost:8089
#   bash load/run-local.sh smoke  → headless ~20 s (CI / vérif rapide), API doit tourner
#
# 1) Terminal A — API :
#   cd backend && python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8000
#
# Optionnel (/me avec JWT) :
#   export LOAD_TEST_EMAIL='...' LOAD_TEST_PASSWORD='...'
#
# Autre hôte :
#   LOAD_HOST=http://127.0.0.1:9000 bash load/run-local.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! python3 -c "import locust" 2>/dev/null; then
  echo "Installe Locust :  pip install -r requirements-load.txt"
  exit 1
fi

HOST="${LOAD_HOST:-http://127.0.0.1:8000}"
MODE="${1:-web}"

preflight() {
  python3 -c "import urllib.request; urllib.request.urlopen('${HOST}/health', timeout=3).read()" >/dev/null 2>&1 || {
    echo "API inaccessible : ${HOST}/health"
    echo "Démarre d'abord :  cd backend && python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8000"
    exit 1
  }
}

case "$MODE" in
  smoke)
    preflight
    echo "Smoke headless → ${HOST} (20 s, jusqu'à 30 utilisateurs Locust)"
    exec python3 -m locust -f load/locustfile.py --host="$HOST" \
      --headless \
      -u 30 \
      -r 10 \
      -t 20s \
      --stop-timeout 5 \
      --exit-code-on-error 1
    ;;
  web|*)
    echo "Interface Locust : http://localhost:8089"
    echo "Cible API : $HOST"
    echo "Sans UI (smoke) :  bash load/run-local.sh smoke"
    exec python3 -m locust -f load/locustfile.py --host="$HOST"
    ;;
esac
