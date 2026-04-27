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
