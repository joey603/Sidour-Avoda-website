from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
import logging

from .database import Base, engine
from .auth import router as auth_router
from .sites import router as sites_router
from .public_workers import router as public_workers_router
from .deps import get_current_user, require_role

logger = logging.getLogger(__name__)


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
        with engine.begin() as conn:  # Utiliser begin() pour une transaction automatique
            dialect_name = engine.dialect.name
            if dialect_name == "sqlite":
                # Migration pour la colonne 'config' sur sites
                cols = conn.exec_driver_sql("PRAGMA table_info(sites)").fetchall()
                col_names = {c[1] for c in cols}
                if "config" not in col_names:
                    conn.exec_driver_sql("ALTER TABLE sites ADD COLUMN config JSON")
                
                # Migration pour la table users: ajouter phone et rendre email nullable
                # Vérifier si la table users existe
                try:
                    user_cols = conn.exec_driver_sql("PRAGMA table_info(users)").fetchall()
                except Exception:
                    # La table n'existe pas encore, elle sera créée par Base.metadata.create_all
                    user_cols = []
                
                if user_cols:
                    user_col_names = {c[1] for c in user_cols}
                    email_col = next((c for c in user_cols if c[1] == "email"), None)
                    # Dans PRAGMA table_info, l'index 3 indique si NOT NULL (0 = NOT NULL, 1 = NULL)
                    email_is_not_null = email_col is not None and email_col[3] == 0
                    phone_exists = "phone" in user_col_names
                    
                    logger.info(f"Migration users: email_is_not_null={email_is_not_null}, phone_exists={phone_exists}, email_col={email_col}")
                    
                    # Toujours recréer la table si email est NOT NULL ou si phone n'existe pas
                    # Cela garantit que la structure est correcte
                    if not phone_exists or email_is_not_null:
                        logger.info("Recréation de la table users avec email nullable et phone")
                        # Recréer la table avec email nullable et phone
                        conn.exec_driver_sql("""
                            CREATE TABLE users_new (
                                id INTEGER PRIMARY KEY,
                                email VARCHAR(255),
                                full_name VARCHAR(255) NOT NULL,
                                hashed_password VARCHAR(255) NOT NULL,
                                role VARCHAR(20) NOT NULL,
                                phone VARCHAR(20)
                            )
                        """)
                        # Copier les données existantes
                        if phone_exists:
                            conn.exec_driver_sql("""
                                INSERT INTO users_new (id, email, full_name, hashed_password, role, phone)
                                SELECT id, email, full_name, hashed_password, role, phone FROM users
                            """)
                        else:
                            conn.exec_driver_sql("""
                                INSERT INTO users_new (id, email, full_name, hashed_password, role, phone)
                                SELECT id, email, full_name, hashed_password, role, NULL FROM users
                            """)
                        # Supprimer les anciens index avant de supprimer la table
                        try:
                            conn.exec_driver_sql("DROP INDEX IF EXISTS ix_users_email")
                        except Exception:
                            pass
                        try:
                            conn.exec_driver_sql("DROP INDEX IF EXISTS ix_users_phone")
                        except Exception:
                            pass
                        conn.exec_driver_sql("DROP TABLE users")
                        conn.exec_driver_sql("ALTER TABLE users_new RENAME TO users")
                        # Recréer les index
                        try:
                            conn.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email ON users(email)")
                        except Exception:
                            pass
                        try:
                            conn.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_phone ON users(phone)")
                        except Exception:
                            pass
                        logger.info("Table users recréée avec succès")
                    elif not phone_exists:
                        # Si seulement phone manque et email est déjà nullable, on peut juste l'ajouter
                        logger.info("Ajout de la colonne phone à la table users")
                        conn.exec_driver_sql("ALTER TABLE users ADD COLUMN phone VARCHAR(20)")
                        try:
                            conn.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_phone ON users(phone)")
                        except Exception:
                            pass
                
                # Migration pour la table site_workers: ajouter user_id
                try:
                    site_worker_cols = conn.exec_driver_sql("PRAGMA table_info(site_workers)").fetchall()
                    site_worker_col_names = {c[1] for c in site_worker_cols}
                    if "user_id" not in site_worker_col_names:
                        logger.info("Ajout de la colonne user_id à la table site_workers")
                        conn.exec_driver_sql("ALTER TABLE site_workers ADD COLUMN user_id INTEGER")
                        try:
                            conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_site_workers_user_id ON site_workers(user_id)")
                        except Exception:
                            pass
                    if "phone" not in site_worker_col_names:
                        logger.info("Ajout de la colonne phone à la table site_workers")
                        conn.exec_driver_sql("ALTER TABLE site_workers ADD COLUMN phone VARCHAR(20)")
                        try:
                            conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_site_workers_phone ON site_workers(phone)")
                        except Exception:
                            pass
                    if "answers" not in site_worker_col_names:
                        logger.info("Ajout de la colonne answers à la table site_workers")
                        conn.exec_driver_sql("ALTER TABLE site_workers ADD COLUMN answers JSON")
                except Exception as e:
                    # La table n'existe peut-être pas encore
                    logger.info(f"Table site_workers pas encore créée ou erreur: {e}")
    except Exception:
        # Safe to ignore in dev if another process handles migration
        pass

    # Routes
    app.include_router(auth_router)
    app.include_router(sites_router)
    app.include_router(public_workers_router)

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


