"""Password hashing helpers for staff account credentials."""

import base64
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from jwt import InvalidTokenError


_HASH_ALGORITHM = "pbkdf2_sha256"
_HASH_ITERATIONS = 600_000
_SALT_BYTES = 16
_HASH_BYTES = 32
ACCESS_TOKEN_MINUTES = 15
ACCESS_TOKEN_ISSUER = "avc-election-api"
ACCESS_TOKEN_AUDIENCE = "avc-election-frontend"


def hash_password(password: str) -> str:
    """Return a salted PBKDF2-SHA256 password hash suitable for storage."""
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, _HASH_ITERATIONS, dklen=_HASH_BYTES
    )
    salt_text = base64.urlsafe_b64encode(salt).decode("ascii").rstrip("=")
    digest_text = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return f"{_HASH_ALGORITHM}${_HASH_ITERATIONS}${salt_text}${digest_text}"


def verify_password(password: str, encoded_hash: str) -> bool:
    """Verify a password against a hash created by :func:`hash_password`."""
    try:
        algorithm, iterations_text, salt_text, digest_text = encoded_hash.split("$", 3)
        iterations = int(iterations_text)
        if algorithm != _HASH_ALGORITHM or not 100_000 <= iterations <= 2_000_000:
            return False

        salt = base64.urlsafe_b64decode(salt_text + "=" * (-len(salt_text) % 4))
        expected = base64.urlsafe_b64decode(digest_text + "=" * (-len(digest_text) % 4))
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, iterations, dklen=len(expected)
        )
        return hmac.compare_digest(actual, expected)
    except (AttributeError, TypeError, ValueError):
        return False


def create_access_token(user_id: int, role: str, secret: str) -> str:
    """Create a short-lived signed access token for an authenticated staff user."""
    now = datetime.now(timezone.utc)
    claims = {
        "sub": str(user_id),
        "role": role,
        "iat": now,
        "exp": now + timedelta(minutes=ACCESS_TOKEN_MINUTES),
        "iss": ACCESS_TOKEN_ISSUER,
        "aud": ACCESS_TOKEN_AUDIENCE,
        "type": "access",
    }
    return jwt.encode(claims, secret, algorithm="HS256")


def decode_access_token(token: str, secret: str) -> dict:
    """Validate a signed access token and return its claims."""
    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            audience=ACCESS_TOKEN_AUDIENCE,
            issuer=ACCESS_TOKEN_ISSUER,
            options={"require": ["sub", "role", "exp", "iat", "type"]},
        )
    except InvalidTokenError as exc:
        raise ValueError("Invalid access token") from exc
    if claims.get("type") != "access":
        raise ValueError("Invalid access token")
    return claims
