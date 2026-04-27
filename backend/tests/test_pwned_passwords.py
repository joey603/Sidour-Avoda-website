"""
Tests Have I Been Pwned (Pwned Passwords) — sans appel réseau réel (mock httpx).
"""

import hashlib

import httpx
import pytest

from app import pwned_passwords
from app.database import settings


def _sha1_upper(pw: str) -> str:
    return hashlib.sha1(pw.encode("utf-8")).hexdigest().upper()


def test_sha1_suffix_split():
    d = _sha1_upper("test")
    assert len(d) == 40
    assert pwned_passwords.sha1_hex_upper("test") == d


def test_unpwned_empty_range_response():
    """Réponse sans ligne correspondant au suffixe → mot de passe non trouvé (unpwned)."""
    pwd = "xYz9_unique_unpwned_ci_suffix________________"
    digest = pwned_passwords.sha1_hex_upper(pwd)
    prefix, suffix = digest[:5], digest[5:]

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url).endswith(prefix)
        body = "000000000000000000000000000000000000000:1\n" "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:2\n"
        return httpx.Response(200, text=body)

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as client:
        assert pwned_passwords.is_password_pwned(pwd, client=client) is False


def test_pwned_when_suffix_present_in_range():
    pwd = "hunter2_pwned_mock_only"
    digest = pwned_passwords.sha1_hex_upper(pwd)
    prefix, suffix = digest[:5], digest[5:]

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url).endswith(prefix)
        body = f"{suffix}:999999\nOTHERFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1\n"
        return httpx.Response(200, text=body)

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as client:
        assert pwned_passwords.is_password_pwned(pwd, client=client) is True


def test_pwned_service_error_on_http_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="")

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as client:
        with pytest.raises(pwned_passwords.PwnedPasswordsServiceError):
            pwned_passwords.is_password_pwned("anything", client=client)


def test_register_rejects_pwned_when_check_enabled(client, monkeypatch):
    monkeypatch.setattr(settings, "enable_pwned_password_check", True)

    def fake_pwned(pw: str) -> bool:
        return pw == "known-leaked-password"

    monkeypatch.setattr(pwned_passwords, "is_password_pwned", fake_pwned)

    r = client.post(
        "/auth/register",
        json={
            "email": "pwned-user@example.com",
            "full_name": "Pwned User",
            "password": "known-leaked-password",
            "role": "worker",
        },
    )
    assert r.status_code == 400
    assert "Pwned" in r.json().get("detail", "") or "fuites" in r.json().get("detail", "")


def test_register_unpwned_when_check_enabled(client, monkeypatch):
    monkeypatch.setattr(settings, "enable_pwned_password_check", True)
    monkeypatch.setattr(pwned_passwords, "is_password_pwned", lambda _pw: False)

    r = client.post(
        "/auth/register",
        json={
            "email": "safe-pwned-check@example.com",
            "full_name": "Safe User",
            "password": "LongRandomPasswordNotLeaked123!@#",
            "role": "worker",
        },
    )
    assert r.status_code == 201, r.text