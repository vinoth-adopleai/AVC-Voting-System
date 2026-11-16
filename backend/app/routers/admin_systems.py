"""Administrator booth and voting system registration endpoints."""

import hashlib
import csv
import base64
import hmac
from io import StringIO
import secrets

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth_dependencies import require_admin
from app.db.connection import get_db_session
from app.db.models import (
    AuditLogRecord,
    ElectionRecord,
    MonitorDeskRecord,
    StaffRole,
    StaffUserRecord,
    SystemStatus,
    VotingSystemRecord,
)
from app.schemas.systems import (
    MonitorDeskAssignment,
    MonitorDeskBulkCreate,
    VotingSystemBulkCreate,
    VotingSystemStatusUpdate,
    VotingSystemTokenExportRequest,
)
from app.settings import settings


router = APIRouter(prefix="/admin", tags=["admin booths and systems"])
_DESK_SYSTEM_LOCK_ID = 741_628_451_038


def _permanent_device_token(system: VotingSystemRecord) -> str:
    """Derive a stable, unique device credential without storing its raw value."""
    configured_secret = settings.device_token_secret.get_secret_value()
    master_secret = configured_secret or settings.access_token_secret.get_secret_value()
    secret_bytes = master_secret.encode("utf-8")
    if len(secret_bytes) < 32:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "DEVICE_TOKEN_SECRET_NOT_CONFIGURED",
                "message": "Configure DEVICE_TOKEN_SECRET with at least 32 characters before issuing system tokens",
            },
        )
    message = f"avc-election:voting-system:v1:{system.election_id}:{system.id}".encode("utf-8")
    digest = hmac.new(secret_bytes, message, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _system_item(system: VotingSystemRecord) -> dict[str, object]:
    return {
        "id": system.id,
        "system_no": system.system_no,
        "name": system.name,
        "status": system.status.value if isinstance(system.status, SystemStatus) else system.status,
        "is_active": system.is_active,
        "last_seen_at": system.last_seen_at,
    }


async def _get_draft_election(election_id: int, session: AsyncSession) -> ElectionRecord:
    election = await session.get(ElectionRecord, election_id, with_for_update=True)
    if election is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "ELECTION_NOT_FOUND", "message": "Election was not found"},
        )
    if election.status != "DRAFT":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "ELECTION_CONFIGURATION_LOCKED", "message": "Booth and system registration is locked after the election opens"},
        )
    return election


@router.get("/systems")
async def list_desks_and_systems(
    election_id: int = Query(gt=0),
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """List booths, assignments, and systems without exposing token hashes."""
    election = await session.get(ElectionRecord, election_id)
    if election is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "ELECTION_NOT_FOUND", "message": "Election was not found"},
        )
    desks = list(await session.scalars(
        select(MonitorDeskRecord)
        .where(MonitorDeskRecord.election_id == election_id)
        .order_by(MonitorDeskRecord.desk_no)
    ))
    systems = list(await session.scalars(
        select(VotingSystemRecord)
        .where(VotingSystemRecord.election_id == election_id)
        .order_by(VotingSystemRecord.system_no)
    ))
    assigned_ids = {
        staff_id
        for desk in desks
        for staff_id in (desk.officer_id, desk.supervisor_id)
        if staff_id is not None
    }
    staff_by_id = {}
    if assigned_ids:
        staff = await session.scalars(
            select(StaffUserRecord).where(StaffUserRecord.id.in_(assigned_ids))
        )
        staff_by_id = {user.id: user for user in staff}
    systems_by_desk: dict[int, list[dict[str, object]]] = {}
    for system in systems:
        systems_by_desk.setdefault(system.monitor_desk_id, []).append(_system_item(system))

    return {
        "election_id": election.id,
        "election_name": election.name,
        "election_status": election.status,
        "desk_count": len(desks),
        "system_count": len(systems),
        "desks": [
            {
                "id": desk.id,
                "desk_no": desk.desk_no,
                "officer": (
                    {"id": staff_by_id[desk.officer_id].id, "full_name": staff_by_id[desk.officer_id].full_name, "username": staff_by_id[desk.officer_id].username}
                    if desk.officer_id in staff_by_id else None
                ),
                "supervisor": (
                    {"id": staff_by_id[desk.supervisor_id].id, "full_name": staff_by_id[desk.supervisor_id].full_name, "username": staff_by_id[desk.supervisor_id].username}
                    if desk.supervisor_id in staff_by_id else None
                ),
                "systems": systems_by_desk.get(desk.id, []),
            }
            for desk in desks
        ],
    }


@router.post("/monitor-desks", status_code=status.HTTP_201_CREATED)
async def create_monitor_desks(
    payload: MonitorDeskBulkCreate,
    admin: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Create a batch of sequentially numbered booths."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": _DESK_SYSTEM_LOCK_ID})
    election = await _get_draft_election(payload.election_id, session)
    last_desk_no = await session.scalar(
        select(func.max(MonitorDeskRecord.desk_no)).where(MonitorDeskRecord.election_id == election.id)
    ) or 0
    if last_desk_no + payload.count > 32_767:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "DESK_LIMIT_REACHED", "message": "The election has reached the booth number limit"},
        )
    desks = [
        MonitorDeskRecord(election_id=election.id, desk_no=number)
        for number in range(last_desk_no + 1, last_desk_no + payload.count + 1)
    ]
    session.add_all(desks)
    try:
        await session.flush()
        session.add(AuditLogRecord(
            actor_id=admin.id,
            action="MONITOR_DESKS_CREATED",
            entity="monitor_desks",
            entity_id=None,
            details={"election_id": election.id, "desk_numbers": [desk.desk_no for desk in desks]},
        ))
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "DESK_REGISTRATION_CONFLICT", "message": "Booths changed during registration; refresh and retry"},
        ) from exc
    return {"created_count": len(desks), "desk_numbers": [desk.desk_no for desk in desks]}


@router.patch("/monitor-desks/{desk_id}/assignment")
async def assign_monitor_desk(
    desk_id: int,
    payload: MonitorDeskAssignment,
    admin: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Assign an active booth officer and optional supervisor to a booth."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": _DESK_SYSTEM_LOCK_ID})
    desk = await session.get(MonitorDeskRecord, desk_id, with_for_update=True)
    if desk is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "MONITOR_DESK_NOT_FOUND", "message": "Booth was not found"},
        )
    await _get_draft_election(desk.election_id, session)
    assigned: dict[str, StaffUserRecord | None] = {}
    for field_name, staff_id, required_role in (
        ("officer", payload.officer_id, StaffRole.MONITOR_OFFICER),
        ("supervisor", payload.supervisor_id, StaffRole.MONITOR_SUPERVISOR),
    ):
        if staff_id is None:
            assigned[field_name] = None
            continue
        user = await session.get(StaffUserRecord, staff_id)
        if user is None or not user.is_active or user.role != required_role:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "code": "INVALID_DESK_ASSIGNMENT",
                    "message": f"Select an active {'booth officer' if required_role == StaffRole.MONITOR_OFFICER else 'booth supervisor'} account",
                },
            )
        assigned[field_name] = user

    desk.officer_id = assigned["officer"].id if assigned["officer"] else None
    desk.supervisor_id = assigned["supervisor"].id if assigned["supervisor"] else None
    session.add(AuditLogRecord(
        actor_id=admin.id,
        action="MONITOR_DESK_ASSIGNED",
        entity="monitor_desks",
        entity_id=str(desk.id),
        details={"officer_id": desk.officer_id, "supervisor_id": desk.supervisor_id},
    ))
    await session.commit()
    return {"id": desk.id, "desk_no": desk.desk_no, "officer_id": desk.officer_id, "supervisor_id": desk.supervisor_id}


@router.post("/voting-systems", status_code=status.HTTP_201_CREATED)
async def create_voting_systems(
    payload: VotingSystemBulkCreate,
    admin: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Register a batch of devices and return their raw tokens once."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": _DESK_SYSTEM_LOCK_ID})
    election = await _get_draft_election(payload.election_id, session)
    desk = await session.get(MonitorDeskRecord, payload.monitor_desk_id, with_for_update=True)
    if desk is None or desk.election_id != election.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "MONITOR_DESK_NOT_FOUND", "message": "Selected booth was not found for this election"},
        )
    last_system_no = await session.scalar(
        select(func.max(VotingSystemRecord.system_no)).where(VotingSystemRecord.election_id == election.id)
    ) or 0
    if last_system_no + payload.count > 32_767:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "SYSTEM_LIMIT_REACHED", "message": "The election has reached the voting system number limit"},
        )

    registered: list[VotingSystemRecord] = []
    for system_no in range(last_system_no + 1, last_system_no + payload.count + 1):
        system = VotingSystemRecord(
            election_id=election.id,
            monitor_desk_id=desk.id,
            system_no=system_no,
            name=f"SYSTEM A{system_no}",
            # This placeholder is replaced with the stable token hash after IDs are assigned.
            token_hash=hashlib.sha256(secrets.token_bytes(32)).hexdigest(),
            status=SystemStatus.FREE,
            is_active=True,
        )
        registered.append(system)
        session.add(system)

    try:
        await session.flush()
        raw_tokens = {system.id: _permanent_device_token(system) for system in registered}
        for system in registered:
            system.token_hash = hashlib.sha256(raw_tokens[system.id].encode("utf-8")).hexdigest()
        await session.flush()
        session.add_all([
            AuditLogRecord(
                actor_id=admin.id,
                action="VOTING_SYSTEM_REGISTERED",
                entity="voting_systems",
                entity_id=str(system.id),
                details={"election_id": election.id, "monitor_desk_id": desk.id, "system_no": system.system_no},
            )
            for system in registered
        ])
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "SYSTEM_REGISTRATION_CONFLICT", "message": "Voting systems changed during registration; refresh and retry"},
        ) from exc

    return {
        "registered_count": len(registered),
        "systems": [
            {**_system_item(system), "monitor_desk_id": desk.id, "token": raw_tokens[system.id]}
            for system in registered
        ],
    }


@router.post("/voting-systems/{system_id}/token")
async def rotate_voting_system_token(
    system_id: int,
    admin: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Return the stable permanent device token for an unoccupied active system."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": _DESK_SYSTEM_LOCK_ID})
    system = await session.scalar(
        select(VotingSystemRecord)
        .where(VotingSystemRecord.id == system_id)
        .with_for_update()
    )
    if system is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "VOTING_SYSTEM_NOT_FOUND", "message": "Voting system was not found"},
        )
    if not system.is_active:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "SYSTEM_DISABLED", "message": "Enable this voting system before issuing its token"},
        )
    if system.status == SystemStatus.OCCUPIED or system.current_voter_id is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "SYSTEM_IS_OCCUPIED", "message": "A token cannot be changed while a voter is assigned to this system"},
        )
    election = await session.get(ElectionRecord, system.election_id)
    if election is None or election.status not in {"DRAFT", "OPEN"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "ELECTION_CLOSED", "message": "Device tokens cannot be changed after the election closes"},
        )

    raw_token = _permanent_device_token(system)
    system.token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    session.add(AuditLogRecord(
        actor_id=admin.id,
        action="VOTING_SYSTEM_TOKEN_DOWNLOADED",
        entity="voting_systems",
        entity_id=str(system.id),
        details={"election_id": system.election_id, "system_no": system.system_no},
    ))
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "TOKEN_ACCESS_CONFLICT", "message": "Could not retrieve the system token; refresh and retry"},
        ) from exc
    return {
        **_system_item(system),
        "monitor_desk_id": system.monitor_desk_id,
        "token": raw_token,
    }


@router.post("/voting-system-tokens/export")
async def export_voting_system_tokens(
    payload: VotingSystemTokenExportRequest,
    admin: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    """Download stable per-system tokens; the same election download is repeatable."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": _DESK_SYSTEM_LOCK_ID})
    election = await session.get(ElectionRecord, payload.election_id, with_for_update=True)
    if election is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "ELECTION_NOT_FOUND", "message": "Election was not found"},
        )
    if election.status not in {"DRAFT", "OPEN"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "ELECTION_CLOSED", "message": "Tokens cannot be exported after the election closes"},
        )

    systems = list(await session.scalars(
        select(VotingSystemRecord)
        .where(VotingSystemRecord.election_id == election.id)
        .order_by(VotingSystemRecord.system_no)
        .with_for_update()
    ))
    if not systems:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "NO_VOTING_SYSTEMS", "message": "Register at least one voting system before exporting tokens"},
        )
    raw_tokens = {system.id: _permanent_device_token(system) for system in systems}
    changed_tokens = any(
        hashlib.sha256(raw_tokens[system.id].encode("utf-8")).hexdigest() != system.token_hash
        for system in systems
    )
    if changed_tokens and any(
        system.status == SystemStatus.OCCUPIED or system.current_voter_id is not None
        for system in systems
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "SYSTEMS_IN_USE", "message": "Finish or safely reset active voter sessions before applying the permanent system tokens for the first time"},
        )

    desk_ids = {system.monitor_desk_id for system in systems}
    desks = list(await session.scalars(
        select(MonitorDeskRecord).where(MonitorDeskRecord.id.in_(desk_ids))
    ))
    booth_numbers = {desk.id: desk.desk_no for desk in desks}

    csv_buffer = StringIO(newline="")
    writer = csv.writer(csv_buffer)
    writer.writerow(["system_name", "system_no", "booth_no", "token"])
    for system in systems:
        raw_token = raw_tokens[system.id]
        system.token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        writer.writerow([
            system.name,
            system.system_no,
            booth_numbers.get(system.monitor_desk_id, ""),
            raw_token,
        ])

    session.add(AuditLogRecord(
        actor_id=admin.id,
        action="VOTING_SYSTEM_TOKENS_DOWNLOADED",
        entity="voting_systems",
        entity_id=str(election.id),
        details={"election_id": election.id, "system_ids": [system.id for system in systems], "token_values_changed": changed_tokens},
    ))
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "TOKEN_EXPORT_CONFLICT", "message": "Could not replace all voting system tokens; refresh and retry"},
        ) from exc

    return Response(
        content="\ufeff" + csv_buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="voting-system-tokens-election-{election.id}.csv"'},
    )


@router.patch("/voting-systems/{system_id}/status")
async def update_voting_system_status(
    system_id: int,
    payload: VotingSystemStatusUpdate,
    admin: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Enable or disable an unoccupied voting system."""
    system = await session.get(VotingSystemRecord, system_id, with_for_update=True)
    if system is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "VOTING_SYSTEM_NOT_FOUND", "message": "Voting system was not found"},
        )
    if not payload.is_active and system.status == SystemStatus.OCCUPIED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "SYSTEM_IS_OCCUPIED", "message": "An occupied voting system cannot be disabled"},
        )
    system.is_active = payload.is_active
    session.add(AuditLogRecord(
        actor_id=admin.id,
        action="VOTING_SYSTEM_ACTIVATED" if payload.is_active else "VOTING_SYSTEM_DEACTIVATED",
        entity="voting_systems",
        entity_id=str(system.id),
        details={"system_no": system.system_no, "election_id": system.election_id},
    ))
    await session.commit()
    return _system_item(system)
