from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware

from .database import Base, engine
from .auth import router as auth_router
from .sites import router as sites_router
from .deps import get_current_user, require_role


def create_app() -> FastAPI:
    app = FastAPI(title="Security Scheduler API")


    # CORS (adapt front URL au besoin)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://0.0.0.0:3000",
            "*",  # fallback dev
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["*"],
        max_age=600,
    )

    # DB
    Base.metadata.create_all(bind=engine)
    # simple migration for SQLite: ensure 'config' column exists on sites
    try:
        with engine.connect() as conn:
            dialect_name = engine.dialect.name
            if dialect_name == "sqlite":
                cols = conn.exec_driver_sql("PRAGMA table_info(sites)").fetchall()
                col_names = {c[1] for c in cols}
                if "config" not in col_names:
                    conn.exec_driver_sql("ALTER TABLE sites ADD COLUMN config JSON")
    except Exception:
        # Safe to ignore in dev if another process handles migration
        pass

    # Routes
    app.include_router(auth_router)
    app.include_router(sites_router)

    @app.get("/me")
    def read_me(user=Depends(get_current_user)):
        return {"id": user.id, "email": user.email, "role": user.role.value, "full_name": user.full_name}

    @app.get("/worker/dashboard")
    def worker_dashboard(user=Depends(require_role("worker"))):
        return {"message": "ברוך הבא, עובד", "user": user.full_name}

    @app.get("/director/dashboard")
    def director_dashboard(user=Depends(require_role("director"))):
        return {"message": "ברוך הבא, מנהל", "user": user.full_name}

    return app


app = create_app()


