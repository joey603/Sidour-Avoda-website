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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Appliquer le meme mot de passe a tous les travailleurs existants."
    )
    parser.add_argument(
        "--password",
        required=True,
        help="Nouveau mot de passe commun (minimum 8 caracteres)",
    )
    parser.add_argument(
        "--only-with-phone",
        action="store_true",
        help="Limiter la mise a jour aux travailleurs qui ont un numero de telephone",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Afficher les comptes qui seraient modifies sans ecrire en base",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    password = str(args.password or "")
    if len(password) < 8:
        print("Le mot de passe doit contenir au moins 8 caracteres.", file=sys.stderr)
        return 1

    db = SessionLocal()
    try:
        query = db.query(User).filter(User.role == UserRole.worker)
        if args.only_with_phone:
            query = query.filter(User.phone.is_not(None))

        workers = query.order_by(User.id.asc()).all()
        if not workers:
            print("Aucun travailleur correspondant.")
            return 0

        print(
            f"{'dry-run: ' if args.dry_run else ''}"
            f"{len(workers)} travailleur(s) cible(s)."
        )
        for user in workers:
            print(
                f"- id={user.id} name={user.full_name} "
                f"phone={user.phone or ''} email={user.email or ''}"
            )

        if args.dry_run:
            return 0

        hashed_password = pwd_context.hash(password)
        for user in workers:
            user.hashed_password = hashed_password

        db.commit()
        print(f"Mot de passe mis a jour pour {len(workers)} travailleur(s).")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
