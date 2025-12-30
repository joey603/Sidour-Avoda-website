"""
Import one local SQLite database into Postgres (Neon/Render).

This is intentionally a "one-shot" script to bootstrap production with local data.

It copies rows (including IDs) for the current core tables:
- users
- sites
- site_workers
- site_assignments
- site_messages

It also tries to JSON-decode JSON columns if the SQLite driver returns strings.
"""

from __future__ import annotations

import argparse
import json
import os
from typing import Any

from sqlalchemy import MetaData, Table, create_engine, select, text

from app.database import DEFAULT_SQLITE_URL
from app.models import Base  # ensures metadata is up to date


TABLE_ORDER = [
    "users",
    "sites",
    "site_workers",
    "site_assignments",
    "site_messages",
]


def _normalize_pg_url(url: str) -> str:
    # Force psycopg3 driver when user pastes "postgresql://..."
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


def _maybe_json(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    s = value.strip()
    if not s:
        return value
    if not (s.startswith("{") or s.startswith("[") or s in ("null", "true", "false")):
        return value
    try:
        return json.loads(s)
    except Exception:
        return value


def _reflect_table(meta: MetaData, name: str) -> Table:
    if name not in meta.tables:
        raise RuntimeError(f"Table introuvable: {name}")
    return meta.tables[name]


def _count_rows(conn, table: Table) -> int:
    return int(conn.execute(select(text("count(*)")).select_from(table)).scalar() or 0)


def _truncate_table(conn, name: str) -> None:
    # Postgres only. CASCADE keeps FK consistency.
    conn.execute(text(f'TRUNCATE TABLE "{name}" RESTART IDENTITY CASCADE'))


def _reset_sequence(conn, table_name: str, pk_name: str = "id") -> None:
    # Works for SERIAL / IDENTITY backed by a sequence.
    conn.execute(
        text(
            """
            SELECT setval(
              pg_get_serial_sequence(:table, :pk),
              COALESCE((SELECT MAX(id) FROM """ + f'"{table_name}"' + """), 1),
              true
            )
            """
        ),
        {"table": table_name, "pk": pk_name},
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Import SQLite dev DB into Postgres.")
    parser.add_argument(
        "--sqlite-path",
        default=None,
        help=(
            "Chemin vers le fichier SQLite (ex: backend/dev.db). "
            "Par défaut: celui attendu par l'app (backend/dev.db)."
        ),
    )
    parser.add_argument(
        "--target-url",
        default=os.getenv("DATABASE_URL", ""),
        help="DATABASE_URL Postgres/Neon (ex: postgresql://...). Par défaut: env DATABASE_URL.",
    )
    parser.add_argument(
        "--truncate",
        action="store_true",
        help="Vide les tables cibles avant import (recommandé pour un bootstrap).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Autorise l'import même si la base cible n'est pas vide.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="N'écrit rien, affiche juste ce qui serait importé.",
    )
    args = parser.parse_args()

    sqlite_path = args.sqlite_path
    if sqlite_path:
        sqlite_url = f"sqlite:///{sqlite_path}"
    else:
        sqlite_url = DEFAULT_SQLITE_URL

    target_url = (args.target_url or "").strip()
    if not target_url:
        raise SystemExit("DATABASE_URL cible manquant (utilise --target-url ou env DATABASE_URL).")
    target_url = _normalize_pg_url(target_url)

    src_engine = create_engine(sqlite_url, connect_args={"check_same_thread": False}, pool_pre_ping=True)
    dst_engine = create_engine(target_url, pool_pre_ping=True)

    if dst_engine.dialect.name != "postgresql":
        raise SystemExit(f"Refus: la base cible n'est pas Postgres (dialect={dst_engine.dialect.name}).")

    # Ensure target schema exists
    Base.metadata.create_all(bind=dst_engine)

    src_meta = MetaData()
    dst_meta = MetaData()
    src_meta.reflect(bind=src_engine)
    dst_meta.reflect(bind=dst_engine)

    with src_engine.connect() as src_conn, dst_engine.begin() as dst_conn:
        # Safety: refuse if not empty unless forced or truncating
        if not args.truncate:
            total_existing = 0
            for t in TABLE_ORDER:
                if t in dst_meta.tables:
                    total_existing += _count_rows(dst_conn, _reflect_table(dst_meta, t))
            if total_existing > 0 and not args.force:
                raise SystemExit(
                    "Base cible non vide. Utilise --truncate (recommandé) ou --force pour continuer."
                )

        if args.truncate and not args.dry_run:
            for t in reversed(TABLE_ORDER):
                _truncate_table(dst_conn, t)

        for tname in TABLE_ORDER:
            if tname not in src_meta.tables:
                print(f"[SKIP] table source absente: {tname}")
                continue
            if tname not in dst_meta.tables:
                raise SystemExit(f"Table cible absente: {tname} (schema mismatch).")

            src_table = _reflect_table(src_meta, tname)
            dst_table = _reflect_table(dst_meta, tname)

            rows = list(src_conn.execute(select(src_table)).mappings().all())
            print(f"[READ] {tname}: {len(rows)} rows")
            if not rows:
                continue

            # Only insert columns that exist on target
            dst_cols = [c.name for c in dst_table.columns]
            json_cols = {c.name for c in dst_table.columns if str(getattr(c.type, "__class__", "")).endswith("JSON")}

            to_insert: list[dict[str, Any]] = []
            for r in rows:
                item: dict[str, Any] = {}
                for k in dst_cols:
                    if k in r:
                        v = r[k]
                        if k in json_cols:
                            v = _maybe_json(v)
                        item[k] = v
                to_insert.append(item)

            if args.dry_run:
                continue

            dst_conn.execute(dst_table.insert(), to_insert)
            print(f"[WRITE] {tname}: inserted {len(to_insert)}")

        if not args.dry_run:
            # Reset sequences so future inserts don't collide
            for tname in TABLE_ORDER:
                try:
                    _reset_sequence(dst_conn, tname, "id")
                except Exception:
                    # table may not have a sequence (or id not serial); ignore
                    pass

    print("✅ Import terminé.")


if __name__ == "__main__":
    main()

