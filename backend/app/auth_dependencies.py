"""Dependencies for authenticated API access."""

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.connection import get_db_session
from app.db.models import StaffRole, StaffUserRecord
from app.security import decode_access_token
from app.settings import settings


_bearer_scheme = HTTPBearer(auto_error=False)


async def require_admin(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
    session: AsyncSession = Depends(get_db_session),
) -> StaffUserRecord:
    """Require a valid, active administrator access token."""
    secret = settings.access_token_secret.get_secret_value()
    if not credentials or len(secret) < 32:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "AUTH_REQUIRED", "message": "Sign in to continue"},
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        claims = decode_access_token(credentials.credentials, secret)
        user_id = int(claims["sub"])
    except (ValueError, KeyError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "INVALID_ACCESS_TOKEN", "message": "Sign in to continue"},
            headers={"WWW-Authenticate": "Bearer"},
        ) from None

    user = await session.get(StaffUserRecord, user_id)
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "INVALID_ACCESS_TOKEN", "message": "Sign in to continue"},
            headers={"WWW-Authenticate": "Bearer"},
        )
    if user.role != StaffRole.ADMIN or claims.get("role") != StaffRole.ADMIN.value:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "ADMIN_REQUIRED", "message": "Administrator access required"},
        )
    return user


async def require_entry_officer(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
    session: AsyncSession = Depends(get_db_session),
) -> StaffUserRecord:
    """Require a valid, active entry-officer access token."""
    secret = settings.access_token_secret.get_secret_value()
    if not credentials or len(secret) < 32:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "AUTH_REQUIRED", "message": "Sign in to continue"},
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        claims = decode_access_token(credentials.credentials, secret)
        user_id = int(claims["sub"])
    except (ValueError, KeyError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "INVALID_ACCESS_TOKEN", "message": "Sign in to continue"},
            headers={"WWW-Authenticate": "Bearer"},
        ) from None

    user = await session.get(StaffUserRecord, user_id)
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "INVALID_ACCESS_TOKEN", "message": "Sign in to continue"},
            headers={"WWW-Authenticate": "Bearer"},
        )
    if user.role != StaffRole.ENTRY_OFFICER or claims.get("role") != StaffRole.ENTRY_OFFICER.value:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "ENTRY_OFFICER_REQUIRED", "message": "Entry officer access required"},
        )
    return user


async def require_booth_staff(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
    session: AsyncSession = Depends(get_db_session),
) -> StaffUserRecord:
    """Require a valid, active booth officer or booth supervisor token."""
    secret = settings.access_token_secret.get_secret_value()
    if not credentials or len(secret) < 32:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "AUTH_REQUIRED", "message": "Sign in to continue"},
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        claims = decode_access_token(credentials.credentials, secret)
        user_id = int(claims["sub"])
    except (ValueError, KeyError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "INVALID_ACCESS_TOKEN", "message": "Sign in to continue"},
            headers={"WWW-Authenticate": "Bearer"},
        ) from None

    user = await session.get(StaffUserRecord, user_id)
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "INVALID_ACCESS_TOKEN", "message": "Sign in to continue"},
            headers={"WWW-Authenticate": "Bearer"},
        )
    allowed_roles = {StaffRole.MONITOR_OFFICER, StaffRole.MONITOR_SUPERVISOR}
    if user.role not in allowed_roles or claims.get("role") != user.role.value:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "BOOTH_STAFF_REQUIRED", "message": "Booth staff access required"},
        )
    return user
