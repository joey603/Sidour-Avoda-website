#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.auth import pwd_context  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import User, UserRole  # noqa: E402


def normalize_phone(value: str | None) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit()).strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Met le numero de telephone comme mot de passe pour les comptes worker "
            "qui ont un telephone."
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Reinitialiser aussi les comptes qui ont deja un mot de passe.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Afficher les comptes concernes sans modifier la base.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    db = SessionLocal()
    try:
        users = (
            db.query(User)
            .filter(User.role == UserRole.worker)
            .filter(User.phone.is_not(None))
            .order_by(User.id.asc())
            .all()
        )
        if not args.force:
            users = [
                user
                for user in users
                if user.hashed_password is None or str(user.hashed_password or "") == ""
            ]
        users = [user for user in users if normalize_phone(user.phone)]

        mode = "force" if args.force else "missing-password-only"
        print(f"{'dry-run: ' if args.dry_run else ''}{len(users)} compte(s) worker a mettre a jour. mode={mode}")
        for user in users:
            print(f"- id={user.id} name={user.full_name} phone={user.phone}")

        if args.dry_run:
            return 0

        for user in users:
            phone = normalize_phone(user.phone)
            user.phone = phone
            user.hashed_password = pwd_context.hash(phone)

        db.commit()
        print(f"Mot de passe mis a jour pour {len(users)} compte(s) worker.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
