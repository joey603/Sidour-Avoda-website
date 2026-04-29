"""
Tests de charge 100 % locaux (Locust → même machine que l’API).

Raccourci :
  cd backend && bash load/run-local.sh
  # ou depuis frontend/web :  npm run load:local

Prérequis : pip install -r requirements-load.txt
API locale : uvicorn app.main:app --host 127.0.0.1 --port 8000

Interface Locust : http://localhost:8089

Optionnel (/me avec JWT) :
  export LOAD_TEST_EMAIL='...' LOAD_TEST_PASSWORD='...'

Planning — mesurer GET travailleurs (charge JSON réelle) :
  export LOAD_TEST_SITE_ID='123'
  export LOAD_TEST_WEEK='2026-04-27'   # début de semaine ISO utilisé par l’app
"""

import os

from locust import HttpUser, between, task


class MixedLoadUser(HttpUser):
    """
    Mélange lecture ultra-légère (/health) et lecture API réaliste (/me avec JWT).
    Sans LOAD_TEST_EMAIL, seules les tâches /health partent (me() no-op si pas de token).
    """

    wait_time = between(0.05, 0.5)

    def on_start(self):
        self.token = None
        email = os.getenv("LOAD_TEST_EMAIL", "").strip()
        password = os.getenv("LOAD_TEST_PASSWORD", "").strip()
        if email and password:
            r = self.client.post("/auth/login", json={"email": email, "password": password})
            if r.status_code == 200:
                self.token = r.json().get("access_token")

    @task(15)
    def health(self):
        self.client.get("/health")

    @task(1)
    def me(self):
        if not self.token:
            return
        self.client.get("/me", headers={"Authorization": f"Bearer {self.token}"})

    @task(2)
    def site_workers_planning(self):
        """GET /director/sites/{id}/workers?week=… — même charge que Planning V2 si variables d’env fournies."""
        if not self.token:
            return
        site_id = os.getenv("LOAD_TEST_SITE_ID", "").strip()
        week = os.getenv("LOAD_TEST_WEEK", "").strip()
        if not site_id or not week:
            return
        self.client.get(
            f"/director/sites/{site_id}/workers?week={week}",
            headers={"Authorization": f"Bearer {self.token}"},
            name="/director/sites/[id]/workers (planning)",
        )
