"""Password hashing, JWT, and at-rest encryption helpers."""
from __future__ import annotations

import base64
import hashlib
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except ValueError:
        return False


def create_access_token(user_id: str) -> str:
    s = get_settings()
    now = datetime.now(timezone.utc)
    payload = {"sub": user_id, "iat": now, "exp": now + timedelta(minutes=s.access_token_minutes)}
    return jwt.encode(payload, s.secret_key, algorithm=s.jwt_algorithm)


def decode_access_token(token: str) -> str | None:
    s = get_settings()
    try:
        payload = jwt.decode(token, s.secret_key, algorithms=[s.jwt_algorithm])
        return str(payload.get("sub"))
    except jwt.PyJWTError:
        return None


def _fernet() -> Fernet:
    s = get_settings()
    if s.encryption_key:
        return Fernet(s.encryption_key.encode())
    digest = hashlib.sha256(("octopus-enc:" + s.secret_key).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt_secret(token: str) -> str | None:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except (InvalidToken, ValueError):
        return None


def mask_secret(value: str) -> str:
    if len(value) <= 8:
        return "••••"
    return f"{value[:3]}••••{value[-4:]}"
