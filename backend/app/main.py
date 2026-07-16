from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
import logging
import os
from threading import Event, Thread

from alembic import command as alembic_command
from alembic.config import Config as AlembicConfig

from .database import SessionLocal, settings
from .auth import router as auth_router
from .sites import (
    router as sites_router,
    compute_auto_planning_scheduler_sleep_seconds,
    process_auto_planning_tick,
)
from .public_workers import router as public_workers_router
from .deps import get_current_user, require_role
from .rate_limit import reset_rate_limits

logger = logging.getLogger(__name__)

_ALEMBIC_INI = os.path.join(os.path.dirname(__file__), "..", "alembic.ini")


def _run_migrations() -> None:
    cfg = AlembicConfig(_ALEMBIC_INI)
    alembic_command.upgrade(cfg, "head")


def create_app() -> FastAPI:
    app = FastAPI(title="Security Scheduler API")
    reset_rate_limits()

    # CORS (adapt front URL au besoin)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:3000",
            "http://localhost:3001",
            "http://localhost:3002",
            "http://127.0.0.1:3000",
            "http://127.0.0.1:3001",
            "http://127.0.0.1:3002",
            "http://0.0.0.0:3000",
        ],
        # Autoriser les previews Vercel (ex: https://xxx.vercel.app) + prod Vercel
        allow_origin_regex=r"^(https://.*\.vercel\.app|http://localhost:\d+|http://127\.0\.0\.1:\d+)$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["*"],
        max_age=600,
    )

    # Run Alembic migrations on startup (idempotent — no-op if already at head)
    try:
        _run_migrations()
    except Exception:
        logger.exception("Alembic migration failed at startup")

    @app.get("/health")
    def health():
        """Sonde légère (chargeurs, k8s, tests de charge) — sans auth ni DB.

        Inclut le dernier statut du watchdog Oracle s'il est présent sur la machine
        (`/var/lib/sidour/watchdog-status.json`).
        """
        watchdog = None
        status_path = os.environ.get(
            "SIDOUR_WATCHDOG_STATUS_PATH",
            "/var/lib/sidour/watchdog-status.json",
        )
        try:
            if os.path.isfile(status_path):
                import json

                with open(status_path, "r", encoding="utf-8") as fh:
                    raw = json.load(fh)
                if isinstance(raw, dict):
                    watchdog = {
                        "state": raw.get("state"),
                        "load1": raw.get("load1"),
                        "uvicorn_cpu": raw.get("uvicorn_cpu"),
                        "last_check": raw.get("last_check"),
                        "last_restart_at": raw.get("last_restart_at"),
                        "last_reason": raw.get("reason"),
                        "health_ms": raw.get("health_ms"),
                        "mem_available_mb": raw.get("mem_available_mb"),
                    }
        except Exception:
            watchdog = None
        return {"status": "ok", "watchdog": watchdog}

    # Routes
    app.include_router(auth_router)
    app.include_router(sites_router)
    app.include_router(public_workers_router)

    @app.get("/me")
    def read_me(user=Depends(get_current_user)):
        return {
            "id": user.id,
            "email": user.email,
            "role": user.role.value,
            "full_name": user.full_name,
            "phone": user.phone,
            "director_code": getattr(user, "director_code", None),
        }

    @app.get("/worker/dashboard")
    def worker_dashboard(user=Depends(require_role("worker"))):
        return {"message": "ברוך הבא, עובד", "user": user.full_name}

    @app.get("/director/dashboard")
    def director_dashboard(user=Depends(require_role("director"))):
        return {"message": "ברוך הבא, מנהל", "user": user.full_name}

    @app.on_event("startup")
    def start_auto_planning_scheduler():
        if not settings.auto_planning_scheduler_enabled:
            logger.info("Auto-planning scheduler disabled")
            return

        existing = getattr(app.state, "auto_planning_thread", None)
        if existing and existing.is_alive():
            return

        stop_event = Event()
        app.state.auto_planning_stop_event = stop_event

        def loop():
            idle_recheck = max(60, int(settings.auto_planning_scheduler_idle_recheck_seconds or 3600))
            while not stop_event.is_set():
                sleep_seconds = idle_recheck
                db = SessionLocal()
                try:
                    sleep_seconds = compute_auto_planning_scheduler_sleep_seconds(
                        db,
                        idle_recheck_seconds=idle_recheck,
                    )
                    if sleep_seconds <= 0:
                        process_auto_planning_tick(db)
                except Exception:
                    logger.exception("Auto-planning scheduler tick failed")
                finally:
                    db.close()
                if stop_event.wait(sleep_seconds):
                    break

        thread = Thread(target=loop, name="auto-planning-scheduler", daemon=True)
        thread.start()
        app.state.auto_planning_thread = thread

    @app.on_event("shutdown")
    def stop_auto_planning_scheduler():
        stop_event = getattr(app.state, "auto_planning_stop_event", None)
        if stop_event:
            try:
                stop_event.set()
            except Exception:
                pass

    return app


app = create_app()


