from datetime import UTC, datetime, timedelta
from typing import Literal

import jwt
from pwdlib import PasswordHash

from app.config import get_settings

TokenType = Literal["access", "refresh"]
ALGORITHM = "HS256"

_hasher = PasswordHash.recommended()  # Argon2id
# Verifying against a fixed hash when the email is unknown keeps login timing the same
# for existing and non-existing accounts.
DUMMY_HASH = _hasher.hash("pulse-timing-equaliser")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    return _hasher.verify(password, hashed)


def create_token(user_id: int, kind: TokenType) -> str:
    settings = get_settings()
    lifetime = (
        timedelta(minutes=settings.access_token_minutes)
        if kind == "access"
        else timedelta(days=settings.refresh_token_days)
    )
    now = datetime.now(UTC)
    payload = {"sub": str(user_id), "typ": kind, "iat": now, "exp": now + lifetime}
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def decode_token(token: str, kind: TokenType) -> int | None:
    """Return the user id, or None for an invalid, expired or wrong-type token."""
    try:
        payload = jwt.decode(token, get_settings().secret_key, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return None
    if payload.get("typ") != kind:
        return None
    try:
        return int(payload["sub"])
    except KeyError, ValueError:
        return None
