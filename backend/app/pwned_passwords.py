"""
Vérification « Have I Been Pwned » (Pwned Passwords) — modèle k-anonymité (préfixe SHA-1 de 5 caractères).

Référence : https://www.troyhunt.com/ive-just-launched-pwned-passwords-version-2/
"""

from __future__ import annotations

import hashlib
import logging

import httpx

logger = logging.getLogger(__name__)

PWNED_PASSWORDS_RANGE_URL = "https://api.pwnedpasswords.com/range/"
DEFAULT_TIMEOUT_S = 5.0
USER_AGENT = "Sidour-Avoda-Backend-PwnedCheck"


class PwnedPasswordsServiceError(Exception):
    """API HIBP indisponible ou erreur réseau."""


def sha1_hex_upper(password: str) -> str:
    return hashlib.sha1(password.encode("utf-8")).hexdigest().upper()


def is_password_pwned(password: str, *, client: httpx.Client | None = None) -> bool:
    """
    Retourne True si le mot de passe apparaît dans la base Pwned Passwords (nombre d’occurrences > 0).

    Lève PwnedPasswordsServiceError si la requête HTTP échoue (timeout, 5xx, etc.).
    """
    digest = sha1_hex_upper(password)
    prefix, suffix = digest[:5], digest[5:]
    url = f"{PWNED_PASSWORDS_RANGE_URL}{prefix}"
    own_client = client is None
    c = client or httpx.Client(timeout=DEFAULT_TIMEOUT_S)
    try:
        r = c.get(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Add-Padding": "true",
            },
        )
        if r.status_code != 200:
            raise PwnedPasswordsServiceError(f"HIBP HTTP {r.status_code}")
        for raw_line in r.text.splitlines():
            line = raw_line.strip()
            if not line or ":" not in line:
                continue
            part, _, _rest = line.partition(":")
            if part.upper() == suffix:
                return True
        return False
    except httpx.HTTPError as e:
        logger.warning("Pwned Passwords request failed: %s", e)
        raise PwnedPasswordsServiceError(str(e)) from e
    finally:
        if own_client:
            c.close()
