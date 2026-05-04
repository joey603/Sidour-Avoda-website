#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.auth import ensure_director_code, pwd_context  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import User, UserRole  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Créer ou mettre à jour un directeur.")
    parser.add_argument("--email", required=True, help="Email du directeur")
    parser.add_argument("--name", required=True, help="Nom complet")
    parser.add_argument("--password", required=True, help="Mot de passe initial")
    parser.add_argument("--phone", default=None, help="Téléphone optionnel")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    email = str(args.email or "").strip().lower()
    full_name = str(args.name or "").strip()
    password = str(args.password or "")
    phone = str(args.phone or "").strip() or None
    if not email or not full_name or len(password) < 8:
        print("Email, nom et mot de passe (>= 8 caracteres) sont requis.", file=sys.stderr)
        return 1

    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.email == email).first()
        if existing and existing.role != UserRole.director:
            print(f"Un compte non-directeur existe deja pour {email}.", file=sys.stderr)
            return 1

        if phone:
            other_phone = db.query(User).filter(User.phone == phone, User.email != email).first()
            if other_phone:
                print(f"Le telephone {phone} est deja utilise par un autre compte.", file=sys.stderr)
                return 1

        if existing:
            existing.full_name = full_name
            existing.phone = phone
            existing.hashed_password = pwd_context.hash(password)
            director = existing
            action = "updated"
        else:
            director = User(
                email=email,
                full_name=full_name,
                hashed_password=pwd_context.hash(password),
                role=UserRole.director,
                phone=phone,
            )
            db.add(director)
            action = "created"

        db.flush()
        ensure_director_code(director, db)
        db.commit()
        db.refresh(director)
        print(
            f"{action}: id={director.id} email={director.email} "
            f"director_code={director.director_code} phone={director.phone or ''}"
        )
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
