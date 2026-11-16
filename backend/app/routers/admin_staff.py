"""Administrator staff account management endpoints."""

import csv
import io
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import ValidationError
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.auth_dependencies import require_admin
from app.db.connection import get_db_session
from app.db.models import AuditLogRecord, StaffAuthSessionRecord, StaffRole, StaffUserRecord
from app.schemas.staff import StaffCreateRequest, StaffStatusUpdate, StaffUpdateRequest
from app.security import hash_password


router = APIRouter(prefix="/admin/staff", tags=["admin staff"])
_STAFF_MANAGEMENT_LOCK_ID = 741_628_451_037
_MAX_IMPORT_BYTES = 5 * 1024 * 1024
_MAX_IMPORT_ROWS = 100


def _staff_payload(user: StaffUserRecord) -> dict[str, object]:
    return {
        "id": user.id,
        "username": user.username,
        "full_name": user.full_name,
        "role": user.role.value,
        "is_active": user.is_active,
        "failed_logins": user.failed_logins,
        "locked_until": user.locked_until,
        "last_login_at": user.last_login_at,
    }


@router.get("")
async def list_staff(
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> list[dict[str, object]]:
    """List staff accounts without returning credentials or MFA secrets."""
    staff = await session.scalars(
        select(StaffUserRecord).order_by(StaffUserRecord.role, StaffUserRecord.username)
    )
    return [_staff_payload(user) for user in staff]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_staff(
    payload: StaffCreateRequest,
    admin: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Create one staff account with an administrator-supplied initial password."""
    password_hash = await run_in_threadpool(hash_password, payload.password.get_secret_value())
    await session.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": _STAFF_MANAGEMENT_LOCK_ID})
    existing = await session.scalar(
        select(StaffUserRecord.id).where(StaffUserRecord.username == payload.username)
    )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "USERNAME_ALREADY_EXISTS", "message": "Username is already in use"},
        )

    user = StaffUserRecord(
        username=payload.username,
        full_name=payload.full_name,
        password_hash=password_hash,
        role=payload.role,
        is_active=True,
    )
    session.add(user)
    try:
        await session.flush()
        session.add(AuditLogRecord(
            actor_id=admin.id,
            action="STAFF_CREATED",
            entity="staff_users",
            entity_id=str(user.id),
            details={"username": user.username, "role": user.role.value},
        ))
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "USERNAME_ALREADY_EXISTS", "message": "Username is already in use"},
        ) from exc
    return _staff_payload(user)


@router.put("/{staff_id}")
async def update_staff(
    staff_id: int,
    payload: StaffUpdateRequest,
    admin: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Update a staff account's identity, role, and optionally its password."""
    password_hash = None
    if payload.password is not None:
        password_hash = await run_in_threadpool(hash_password, payload.password.get_secret_value())

    await session.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": _STAFF_MANAGEMENT_LOCK_ID})
    user = await session.get(StaffUserRecord, staff_id, with_for_update=True)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "STAFF_NOT_FOUND", "message": "Staff account was not found"},
        )

    if user.username != payload.username:
        existing = await session.scalar(
            select(StaffUserRecord.id).where(
                StaffUserRecord.username == payload.username,
                StaffUserRecord.id != user.id,
            )
        )
        if existing is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "USERNAME_ALREADY_EXISTS", "message": "Username is already in use"},
            )

    if user.is_active and user.role == StaffRole.ADMIN and payload.role != StaffRole.ADMIN:
        active_admins = await session.scalar(
            select(func.count()).select_from(StaffUserRecord).where(
                StaffUserRecord.role == StaffRole.ADMIN,
                StaffUserRecord.is_active.is_(True),
            )
        )
        if active_admins <= 1:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "LAST_ACTIVE_ADMIN", "message": "At least one active administrator must remain"},
            )

    previous_values = {
        "username": user.username,
        "full_name": user.full_name,
        "role": user.role.value,
    }
    user.username = payload.username
    user.full_name = payload.full_name
    user.role = payload.role
    if password_hash is not None:
        user.password_hash = password_hash
        await session.execute(
            update(StaffAuthSessionRecord)
            .where(
                StaffAuthSessionRecord.staff_user_id == user.id,
                StaffAuthSessionRecord.revoked_at.is_(None),
            )
            .values(revoked_at=datetime.now(timezone.utc))
        )

    session.add(AuditLogRecord(
        actor_id=admin.id,
        action="STAFF_UPDATED",
        entity="staff_users",
        entity_id=str(user.id),
        details={
            "previous": previous_values,
            "updated": {
                "username": user.username,
                "full_name": user.full_name,
                "role": user.role.value,
                "password_changed": password_hash is not None,
            },
        },
    ))
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "USERNAME_ALREADY_EXISTS", "message": "Username is already in use"},
        ) from exc
    return _staff_payload(user)


@router.patch("/{staff_id}/status")
async def update_staff_status(
    staff_id: int,
    payload: StaffStatusUpdate,
    admin: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Activate or deactivate a staff account, protecting the last active admin."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": _STAFF_MANAGEMENT_LOCK_ID})
    user = await session.get(StaffUserRecord, staff_id, with_for_update=True)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "STAFF_NOT_FOUND", "message": "Staff account was not found"},
        )
    if not payload.is_active and user.id == admin.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "CANNOT_DEACTIVATE_SELF", "message": "You cannot deactivate your own account"},
        )
    if not payload.is_active and user.role == StaffRole.ADMIN and user.is_active:
        active_admins = await session.scalar(
            select(func.count()).select_from(StaffUserRecord).where(
                StaffUserRecord.role == StaffRole.ADMIN,
                StaffUserRecord.is_active.is_(True),
            )
        )
        if active_admins <= 1:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "LAST_ACTIVE_ADMIN", "message": "At least one active administrator must remain"},
            )

    user.is_active = payload.is_active
    if not payload.is_active:
        await session.execute(
            update(StaffAuthSessionRecord)
            .where(
                StaffAuthSessionRecord.staff_user_id == user.id,
                StaffAuthSessionRecord.revoked_at.is_(None),
            )
            .values(revoked_at=datetime.now(timezone.utc))
        )
    session.add(AuditLogRecord(
        actor_id=admin.id,
        action="STAFF_ACTIVATED" if payload.is_active else "STAFF_DEACTIVATED",
        entity="staff_users",
        entity_id=str(user.id),
        details={"username": user.username, "role": user.role.value},
    ))
    await session.commit()
    return _staff_payload(user)


@router.post("/import")
async def import_staff_csv(
    file: UploadFile = File(...),
    admin: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Create staff accounts from username, full_name, role, and password columns."""
    if file.filename and not file.filename.lower().endswith(".csv"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "CSV_FILE_REQUIRED", "message": "Choose a .csv file"},
        )
    data = await file.read(_MAX_IMPORT_BYTES + 1)
    await file.close()
    if not data or len(data) > _MAX_IMPORT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={"code": "CSV_SIZE_INVALID", "message": "Staff CSV files must be non-empty and 5 MB or smaller"},
        )
    try:
        source = io.StringIO(data.decode("utf-8-sig"), newline="")
        reader = csv.DictReader(source, strict=True)
        headers = [header.strip().lower() if header else "" for header in (reader.fieldnames or [])]
        required_headers = {"username", "full_name", "role", "password"}
        if not headers or len(headers) != len(set(headers)) or set(headers) != required_headers:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "code": "INVALID_STAFF_CSV_COLUMNS",
                    "message": "CSV headers must be username, full_name, role, password",
                },
            )
        parsed: list[tuple[int, StaffCreateRequest]] = []
        row_errors: list[dict[str, object]] = []
        seen_usernames: set[str] = set()
        for row_number, row in enumerate(reader, start=2):
            if row_number - 1 > _MAX_IMPORT_ROWS:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail={"code": "STAFF_CSV_TOO_MANY_ROWS", "message": f"Staff CSV files can contain at most {_MAX_IMPORT_ROWS} accounts"},
                )
            if not row or not any((value or "").strip() for value in row.values() if isinstance(value, str)):
                continue
            try:
                account = StaffCreateRequest.model_validate(row)
            except ValidationError as exc:
                row_errors.append({"row_number": row_number, "errors": [item["msg"] for item in exc.errors()]})
                continue
            if account.username in seen_usernames:
                row_errors.append({"row_number": row_number, "username": account.username, "errors": ["Username is duplicated in this CSV"]})
                continue
            seen_usernames.add(account.username)
            parsed.append((row_number, account))
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_CSV_ENCODING", "message": "Save the CSV as UTF-8 and upload it again"},
        ) from exc
    except csv.Error as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "MALFORMED_CSV", "message": "The uploaded CSV could not be parsed"},
        ) from exc

    if not parsed:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "NO_STAFF_ROWS", "message": "The CSV does not contain any valid staff accounts", "rows": row_errors},
        )

    await session.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": _STAFF_MANAGEMENT_LOCK_ID})
    requested_usernames = [account.username for _, account in parsed]
    existing_usernames = set(await session.scalars(
        select(StaffUserRecord.username).where(StaffUserRecord.username.in_(requested_usernames))
    ))
    for row_number, account in parsed:
        if account.username in existing_usernames:
            row_errors.append({"row_number": row_number, "username": account.username, "errors": ["Username already exists"]})
    if row_errors:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "STAFF_CSV_HAS_ERRORS",
                "message": "Fix the listed rows before importing; no accounts were created",
                "rows": row_errors,
            },
        )

    new_users = []
    for _, account in parsed:
        password_hash = await run_in_threadpool(hash_password, account.password.get_secret_value())
        new_users.append(StaffUserRecord(
            username=account.username,
            full_name=account.full_name,
            password_hash=password_hash,
            role=account.role,
            is_active=True,
        ))
    session.add_all(new_users)
    try:
        await session.flush()
        session.add_all([
            AuditLogRecord(
                actor_id=admin.id,
                action="STAFF_CREATED",
                entity="staff_users",
                entity_id=str(user.id),
                details={"username": user.username, "role": user.role.value, "source": "csv"},
            )
            for user in new_users
        ])
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "STAFF_IMPORT_CONFLICT", "message": "Staff accounts changed during import. Retry with an updated CSV."},
        ) from exc

    return {
        "created_count": len(new_users),
        "accounts": [_staff_payload(user) for user in new_users],
    }
