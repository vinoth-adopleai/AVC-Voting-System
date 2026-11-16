"""Authentication and first administrator bootstrap endpoints."""

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.db.connection import get_db_session
from app.db.models import StaffAuthSessionRecord, StaffRole, StaffUserRecord
from app.schemas.auth import (
    AuthSessionResponse,
    AuthenticatedUser,
    BootstrapAdminRequest,
    BootstrapAdminResponse,
    LoginRequest,
)
from app.security import create_access_token, hash_password, verify_password
from app.settings import settings


router = APIRouter(prefix="/auth", tags=["auth"])
_ADMIN_BOOTSTRAP_LOCK_ID = 741_628_451_032
_REFRESH_COOKIE_NAME = "avc_refresh"
_REFRESH_TOKEN_DAYS = 7
_MAX_FAILED_LOGINS = 5
_LOCKOUT_MINUTES = 15
_DUMMY_PASSWORD_HASH = hash_password("invalid-account-timing-check")


def _access_signing_secret() -> str:
    secret = settings.access_token_secret.get_secret_value()
    if len(secret) < 32:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "AUTH_NOT_CONFIGURED",
                "message": "Authentication signing key is not configured",
            },
        )
    return secret


def _create_session_tokens(
    user: StaffUserRecord,
    signing_secret: str,
    now: datetime,
) -> tuple[str, StaffAuthSessionRecord, AuthSessionResponse]:
    refresh_token = secrets.token_urlsafe(48)
    refresh_hash = hashlib.sha256(refresh_token.encode("utf-8")).hexdigest()
    session_record = StaffAuthSessionRecord(
        refresh_token_hash=refresh_hash,
        staff_user_id=user.id,
        expires_at=now + timedelta(days=_REFRESH_TOKEN_DAYS),
    )
    response = AuthSessionResponse(
        access_token=create_access_token(user.id, user.role.value, signing_secret),
        user=AuthenticatedUser(
            id=user.id,
            username=user.username,
            display_name=user.full_name or user.username,
            role=user.role,
        ),
    )
    return refresh_token, session_record, response


def _set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=_REFRESH_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite="lax",
        path="/",
        max_age=_REFRESH_TOKEN_DAYS * 24 * 60 * 60,
    )


def _refresh_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@router.post(
    "/bootstrap-admin",
    response_model=BootstrapAdminResponse,
    status_code=status.HTTP_201_CREATED,
)
async def bootstrap_admin(
    payload: BootstrapAdminRequest,
    x_bootstrap_token: str | None = Header(default=None, alias="X-Bootstrap-Token"),
    session: AsyncSession = Depends(get_db_session),
) -> BootstrapAdminResponse:
    """Create the first admin exactly once using a secret supplied out of band."""
    expected_token = settings.admin_bootstrap_token.get_secret_value()
    if not expected_token:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "BOOTSTRAP_DISABLED", "message": "Admin bootstrap is disabled"},
        )
    if not x_bootstrap_token or not hmac.compare_digest(x_bootstrap_token, expected_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "INVALID_BOOTSTRAP_TOKEN", "message": "Invalid bootstrap token"},
        )

    password_hash = await run_in_threadpool(
        hash_password, payload.password.get_secret_value()
    )

    async with session.begin():
        # Serialize concurrent first-admin requests, including across API workers.
        await session.execute(
            text("SELECT pg_advisory_xact_lock(:lock_id)"),
            {"lock_id": _ADMIN_BOOTSTRAP_LOCK_ID},
        )
        existing_admin_id = await session.scalar(
            select(StaffUserRecord.id)
            .where(StaffUserRecord.role == StaffRole.ADMIN)
            .limit(1)
        )
        if existing_admin_id is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "ADMIN_ALREADY_EXISTS", "message": "An admin account already exists"},
            )

        existing_username_id = await session.scalar(
            select(StaffUserRecord.id)
            .where(StaffUserRecord.username == payload.username)
            .limit(1)
        )
        if existing_username_id is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "USERNAME_ALREADY_EXISTS", "message": "Username is already in use"},
            )

        admin = StaffUserRecord(
            username=payload.username,
            full_name=payload.full_name,
            password_hash=password_hash,
            role=StaffRole.ADMIN,
            is_active=True,
        )
        session.add(admin)
        await session.flush()

        response = BootstrapAdminResponse(
            id=admin.id,
            username=admin.username,
            display_name=admin.full_name or admin.username,
            role=admin.role,
            is_active=admin.is_active,
        )

    return response


@router.post("/login", response_model=AuthSessionResponse)
async def login(
    payload: LoginRequest,
    response: Response,
    session: AsyncSession = Depends(get_db_session),
) -> AuthSessionResponse:
    """Authenticate a staff account and issue an access token and refresh cookie."""
    signing_secret = _access_signing_secret()
    now = datetime.now(timezone.utc)
    supplied_password = payload.password.get_secret_value()
    auth_response: AuthSessionResponse | None = None
    refresh_token: str | None = None
    account_is_locked = False
    mfa_not_supported = False

    async with session.begin():
        user = await session.scalar(
            select(StaffUserRecord)
            .where(StaffUserRecord.username == payload.username)
            .with_for_update()
        )
        stored_hash = user.password_hash if user is not None else _DUMMY_PASSWORD_HASH
        password_matches = await run_in_threadpool(
            verify_password, supplied_password, stored_hash
        )

        if user is not None:
            if user.locked_until is not None and user.locked_until <= now:
                user.locked_until = None
                user.failed_logins = 0

            account_is_locked = user.locked_until is not None and user.locked_until > now
            if user.is_active and not account_is_locked and password_matches:
                if user.totp_secret_enc:
                    mfa_not_supported = True
                else:
                    user.failed_logins = 0
                    user.locked_until = None
                    user.last_login_at = now
                    refresh_token, session_record, auth_response = _create_session_tokens(
                        user, signing_secret, now
                    )
                    session.add(session_record)
            elif user.is_active and not account_is_locked:
                user.failed_logins = min(user.failed_logins + 1, 32_767)
                if user.failed_logins >= _MAX_FAILED_LOGINS:
                    user.locked_until = now + timedelta(minutes=_LOCKOUT_MINUTES)

    if mfa_not_supported:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail={
                "code": "MFA_NOT_IMPLEMENTED",
                "message": "This account requires multi-factor authentication, which is not configured yet",
            },
        )
    if auth_response is None or refresh_token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "INVALID_CREDENTIALS",
                "message": "Invalid username or password",
            },
            headers={"WWW-Authenticate": "Bearer"},
        )

    _set_refresh_cookie(response, refresh_token)
    return auth_response


@router.post("/refresh", response_model=AuthSessionResponse)
async def refresh_session(
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db_session),
) -> AuthSessionResponse:
    """Rotate a valid refresh cookie and issue a fresh short-lived access token."""
    signing_secret = _access_signing_secret()
    refresh_token = request.cookies.get(_REFRESH_COOKIE_NAME)
    if not refresh_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "SESSION_EXPIRED", "message": "Sign in to continue"},
        )

    now = datetime.now(timezone.utc)
    next_refresh_token: str | None = None
    auth_response: AuthSessionResponse | None = None
    async with session.begin():
        current_session = await session.scalar(
            select(StaffAuthSessionRecord)
            .where(
                StaffAuthSessionRecord.refresh_token_hash
                == _refresh_token_hash(refresh_token)
            )
            .with_for_update()
        )
        if (
            current_session is not None
            and current_session.revoked_at is None
            and current_session.expires_at > now
        ):
            user = await session.get(StaffUserRecord, current_session.staff_user_id)
            if user is not None and user.is_active:
                current_session.revoked_at = now
                next_refresh_token, next_session, auth_response = _create_session_tokens(
                    user, signing_secret, now
                )
                session.add(next_session)
            else:
                current_session.revoked_at = now

    if auth_response is None or next_refresh_token is None:
        response.delete_cookie(
            key=_REFRESH_COOKIE_NAME,
            httponly=True,
            secure=settings.auth_cookie_secure,
            samesite="lax",
            path="/",
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "SESSION_EXPIRED", "message": "Sign in to continue"},
        )

    _set_refresh_cookie(response, next_refresh_token)
    return auth_response


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    """Revoke the refresh session and clear its browser cookie."""
    refresh_token = request.cookies.get(_REFRESH_COOKIE_NAME)
    if refresh_token:
        async with session.begin():
            await session.execute(
                update(StaffAuthSessionRecord)
                .where(
                    StaffAuthSessionRecord.refresh_token_hash
                    == _refresh_token_hash(refresh_token),
                    StaffAuthSessionRecord.revoked_at.is_(None),
                )
                .values(revoked_at=datetime.now(timezone.utc))
            )

    response.delete_cookie(
        key=_REFRESH_COOKIE_NAME,
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite="lax",
        path="/",
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response
