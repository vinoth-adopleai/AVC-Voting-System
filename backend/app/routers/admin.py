"""Administrator election setup endpoints."""

from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth_dependencies import require_admin
from app.db.connection import get_db_session
from app.db.models import (
    AuditLogRecord,
    CandidateRecord,
    ElectionRecord,
    MonitorDeskRecord,
    PositionRecord,
    StaffRole,
    StaffUserRecord,
    VoterRecord,
    VotingSystemRecord,
)
from app.schemas.admin import (
    ElectionSetupRequest,
    ElectionSetupResponse,
    ElectionOptionResponse,
    ElectionOpenRequest,
    ElectionCloseRequest,
    PositionCreateRequest,
    PositionUpdateRequest,
    PositionListResponse,
    PositionResponse,
)


router = APIRouter(prefix="/admin", tags=["admin"])
_ELECTION_SETUP_LOCK_ID = 741_628_451_033
_POSITIONS_SETUP_LOCK_ID = 741_628_451_034


async def _election_readiness(
    election: ElectionRecord,
    session: AsyncSession,
    *,
    confirm_servers_healthy: bool = False,
) -> dict[str, object]:
    positions = list(await session.scalars(
        select(PositionRecord).where(PositionRecord.election_id == election.id)
    ))
    position_ids = [position.id for position in positions]
    candidate_counts: dict[int, int] = {}
    if position_ids:
        candidate_rows = await session.execute(
            select(CandidateRecord.position_id, func.count(CandidateRecord.id))
            .where(
                CandidateRecord.position_id.in_(position_ids),
                CandidateRecord.is_active.is_(True),
            )
            .group_by(CandidateRecord.position_id)
        )
        candidate_counts = {position_id: count for position_id, count in candidate_rows}

    voter_count = await session.scalar(
        select(func.count(VoterRecord.id)).where(VoterRecord.election_id == election.id)
    ) or 0
    desks = list(await session.scalars(
        select(MonitorDeskRecord).where(MonitorDeskRecord.election_id == election.id)
    ))
    assigned_desk_count = sum(1 for desk in desks if desk.officer_id is not None)
    active_officer_count = 0
    if desks:
        active_officer_count = await session.scalar(
            select(func.count(MonitorDeskRecord.id))
            .join(StaffUserRecord, StaffUserRecord.id == MonitorDeskRecord.officer_id)
            .where(
                MonitorDeskRecord.election_id == election.id,
                StaffUserRecord.is_active.is_(True),
                StaffUserRecord.role == StaffRole.MONITOR_OFFICER,
            )
        ) or 0
    system_count = await session.scalar(
        select(func.count(VotingSystemRecord.id)).where(
            VotingSystemRecord.election_id == election.id,
            VotingSystemRecord.is_active.is_(True),
        )
    ) or 0
    assigned_system_count = await session.scalar(
        select(func.count(VotingSystemRecord.id))
        .join(MonitorDeskRecord, MonitorDeskRecord.id == VotingSystemRecord.monitor_desk_id)
        .join(StaffUserRecord, StaffUserRecord.id == MonitorDeskRecord.officer_id)
        .where(
            VotingSystemRecord.election_id == election.id,
            MonitorDeskRecord.election_id == election.id,
            VotingSystemRecord.is_active.is_(True),
            StaffUserRecord.is_active.is_(True),
            StaffUserRecord.role == StaffRole.MONITOR_OFFICER,
        )
    ) or 0
    active_entry_officer_count = await session.scalar(
        select(func.count(StaffUserRecord.id)).where(
            StaffUserRecord.is_active.is_(True),
            StaffUserRecord.role == StaffRole.ENTRY_OFFICER,
        )
    ) or 0
    other_open_elections = await session.scalar(
        select(func.count(ElectionRecord.id)).where(
            ElectionRecord.status == "OPEN",
            ElectionRecord.id != election.id,
        )
    ) or 0

    max_choices = sum(position.max_choices for position in positions)
    checks = {
        "positions": {"ready": len(positions) == 7, "actual": len(positions), "expected": 7},
        "ballot_total": {
            "ready": max_choices == election.ballot_total,
            "actual": max_choices,
            "expected": election.ballot_total,
        },
        "candidates": {
            "ready": bool(positions) and all(candidate_counts.get(position.id, 0) > 0 for position in positions),
            "actual": sum(candidate_counts.values()),
            "expected": "At least one active candidate per position",
        },
        "voters": {"ready": voter_count > 0, "actual": voter_count, "expected": "At least one voter"},
        "entry_officers": {
            "ready": active_entry_officer_count > 0,
            "actual": active_entry_officer_count,
            "expected": "At least one active entry officer",
        },
        "systems": {"ready": system_count > 0, "actual": system_count, "expected": "At least one active system"},
        "system_booth_officers": {
            "ready": system_count > 0 and assigned_system_count == system_count,
            "actual": f"{assigned_system_count} / {system_count} active systems",
            "expected": "Every active voting system is assigned to a booth with an active officer",
        },
        "booth_officers": {
            "ready": bool(desks) and assigned_desk_count == len(desks) and active_officer_count == len(desks),
            "actual": active_officer_count,
            "expected": f"Active booth officer assigned to all {len(desks)} booths",
        },
        "servers": {
            "ready": confirm_servers_healthy,
            "actual": "Confirmed by administrator" if confirm_servers_healthy else "Not confirmed",
            "expected": "At least 2 healthy API servers",
        },
        "single_open_election": {
            "ready": other_open_elections == 0,
            "actual": other_open_elections,
            "expected": "No other open election",
        },
    }
    required_checks = [value["ready"] for key, value in checks.items() if key != "servers"]
    return {
        "election_id": election.id,
        "election_name": election.name,
        "status": election.status,
        "checks": checks,
        "ready": all(required_checks),
        "can_open": all(value["ready"] for value in checks.values()),
    }


@router.get("/election/readiness")
async def get_election_readiness(
    election_id: int | None = Query(default=None, gt=0),
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object] | None:
    """Return setup checks required before opening the selected draft election."""
    election_query = select(ElectionRecord).order_by(ElectionRecord.id.desc())
    if election_id is not None:
        election_query = select(ElectionRecord).where(ElectionRecord.id == election_id)
    election = await session.scalar(election_query.limit(1))
    if election is None:
        return None
    return await _election_readiness(election, session)


@router.post("/election/open", response_model=ElectionSetupResponse)
async def open_election(
    payload: ElectionOpenRequest,
    admin: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> ElectionRecord:
    """Open the selected draft election only after every pre-flight check passes."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": _ELECTION_SETUP_LOCK_ID})
    election = await session.scalar(
        (select(ElectionRecord).where(ElectionRecord.id == payload.election_id)
         if payload.election_id is not None else select(ElectionRecord).order_by(ElectionRecord.id.desc()).limit(1))
        .with_for_update()
    )
    if election is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "ELECTION_NOT_CONFIGURED", "message": "Create an election before opening it"},
        )
    if election.status != "DRAFT":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "ELECTION_NOT_DRAFT", "message": "Only a draft election can be opened"},
        )

    readiness = await _election_readiness(
        election,
        session,
        confirm_servers_healthy=payload.confirm_servers_healthy,
    )
    if not readiness["can_open"]:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "ELECTION_NOT_READY",
                "message": "Complete every pre-flight check before opening the election",
                "readiness": readiness,
            },
        )

    election.status = "OPEN"
    election.start_time = func.now()
    session.add(AuditLogRecord(
        actor_id=admin.id,
        action="ELECTION_OPENED",
        entity="elections",
        entity_id=str(election.id),
        details={"name": election.name, "ballot_total": election.ballot_total},
    ))
    await session.commit()
    await session.refresh(election)
    return election


@router.post("/election/close", response_model=ElectionSetupResponse)
async def close_election(
    payload: ElectionCloseRequest,
    admin: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> ElectionRecord:
    """Stop the currently open election and record the administrator action."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": _ELECTION_SETUP_LOCK_ID})
    election = await session.scalar(
        (select(ElectionRecord).where(ElectionRecord.id == payload.election_id)
         if payload.election_id is not None else select(ElectionRecord).order_by(ElectionRecord.id.desc()).limit(1))
        .with_for_update()
    )
    if election is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "ELECTION_NOT_CONFIGURED", "message": "Create an election before stopping it"},
        )
    if election.status != "OPEN":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "ELECTION_NOT_OPEN", "message": "Only an open election can be stopped"},
        )

    election.status = "CLOSED"
    election.end_time = func.now()
    session.add(AuditLogRecord(
        actor_id=admin.id,
        action="ELECTION_CLOSED",
        entity="elections",
        entity_id=str(election.id),
        details={"name": election.name},
    ))
    await session.commit()
    await session.refresh(election)
    return election


@router.get("/elections", response_model=list[ElectionOptionResponse])
async def list_elections(
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> list[ElectionRecord]:
    """List elections for the position form election selector."""
    elections = await session.scalars(
        select(ElectionRecord).order_by(ElectionRecord.id.desc())
    )
    return list(elections)


@router.get("/election", response_model=ElectionSetupResponse | None)
async def get_election_setup(
    election_id: int | None = Query(default=None, gt=0),
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> ElectionRecord | None:
    """Return one selected election or the most recently configured election."""
    election_query = select(ElectionRecord).order_by(ElectionRecord.id.desc())
    if election_id is not None:
        election_query = select(ElectionRecord).where(ElectionRecord.id == election_id)
    return await session.scalar(election_query.limit(1))


@router.put("/election", response_model=ElectionSetupResponse)
async def save_election_setup(
    payload: ElectionSetupRequest,
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> ElectionRecord:
    """Create a new election or update the selected draft election."""
    # The auth dependency has already queried through this request session, so
    # SQLAlchemy has autobegun the transaction before this handler runs.
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:lock_id)"),
        {"lock_id": _ELECTION_SETUP_LOCK_ID},
    )
    election = None
    if payload.election_id is not None:
        election = await session.scalar(
            select(ElectionRecord).where(ElectionRecord.id == payload.election_id).with_for_update()
        )
        if election is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"code": "ELECTION_NOT_FOUND", "message": "Election was not found"},
            )
    if election is not None and election.status != "DRAFT":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "ELECTION_CONFIGURATION_LOCKED",
                "message": "Election details cannot be changed after the election opens",
            },
        )
    if election is None:
        election = ElectionRecord(
            name=payload.name,
            election_date=payload.election_date,
            ballot_total=23,
            status="DRAFT",
        )
        session.add(election)
    else:
        election.name = payload.name
        election.election_date = payload.election_date
    await session.flush()
    await session.refresh(election)
    await session.commit()
    return election


@router.get("/positions", response_model=PositionListResponse)
async def list_positions(
    election_id: int | None = None,
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> PositionListResponse:
    """List positions for the current election and expose its setup status."""
    election_query = select(ElectionRecord).order_by(ElectionRecord.id.desc())
    if election_id is not None:
        election_query = select(ElectionRecord).where(ElectionRecord.id == election_id)
    election = await session.scalar(election_query.limit(1))
    if election is None:
        return PositionListResponse(
            election_id=None,
            election_name=None,
            election_status=None,
            positions=[],
        )

    positions = await session.scalars(
        select(PositionRecord)
        .where(PositionRecord.election_id == election.id)
        .order_by(PositionRecord.display_order)
    )
    return PositionListResponse(
        election_id=election.id,
        election_name=election.name,
        election_status=election.status,
        positions=list(positions),
    )


@router.post(
    "/positions",
    response_model=PositionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_position(
    payload: PositionCreateRequest,
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> PositionRecord:
    """Add a named position and generate its public code from its database ID."""
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:lock_id)"),
        {"lock_id": _POSITIONS_SETUP_LOCK_ID},
    )
    election = await session.get(ElectionRecord, payload.election_id, with_for_update=True)
    if election is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "ELECTION_NOT_CONFIGURED",
                "message": "Create an election before adding positions",
            },
        )
    if election.status != "DRAFT":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "ELECTION_CONFIGURATION_LOCKED",
                "message": "Positions cannot be changed after the election opens",
            },
        )

    existing = await session.scalars(
        select(PositionRecord.display_order).where(
            PositionRecord.election_id == election.id
        )
    )
    used_orders = set(existing)
    display_order = next(
        (slot for slot in range(1, 8) if slot not in used_orders),
        None,
    )
    if display_order is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "POSITION_LIMIT_REACHED",
                "message": "This election already has all seven positions",
            },
        )

    position = PositionRecord(
        election_id=election.id,
        code=f"pending-{uuid4().hex}",
        name_en=payload.name_en,
        name_ta=payload.name_ta,
        min_choices=payload.min_choices,
        max_choices=payload.max_choices,
        display_order=display_order,
    )
    session.add(position)
    await session.flush()
    position.code = f"AVC{position.id}"
    await session.flush()
    await session.refresh(position)
    await session.commit()
    return position


@router.put("/positions/{position_id}", response_model=PositionResponse)
async def update_position(
    position_id: int,
    payload: PositionUpdateRequest,
    admin: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> PositionRecord:
    """Update a position's names and vote limits while its election is a draft."""
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:lock_id)"),
        {"lock_id": _POSITIONS_SETUP_LOCK_ID},
    )
    position = await session.get(PositionRecord, position_id, with_for_update=True)
    if position is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "POSITION_NOT_FOUND", "message": "Position was not found"},
        )
    election = await session.get(ElectionRecord, position.election_id, with_for_update=True)
    if election is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "ELECTION_NOT_FOUND", "message": "Position election was not found"},
        )
    if election.status != "DRAFT":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "ELECTION_CONFIGURATION_LOCKED",
                "message": "Positions cannot be changed after the election opens",
            },
        )

    previous_values = {
        "name_en": position.name_en,
        "name_ta": position.name_ta,
        "min_choices": position.min_choices,
        "max_choices": position.max_choices,
    }
    position.name_en = payload.name_en
    position.name_ta = payload.name_ta
    position.min_choices = payload.min_choices
    position.max_choices = payload.max_choices
    session.add(AuditLogRecord(
        actor_id=admin.id,
        action="POSITION_UPDATED",
        entity="positions",
        entity_id=str(position.id),
        details={
            "election_id": election.id,
            "previous": previous_values,
            "updated": {
                "name_en": position.name_en,
                "name_ta": position.name_ta,
                "min_choices": position.min_choices,
                "max_choices": position.max_choices,
            },
        },
    ))
    await session.commit()
    await session.refresh(position)
    return position
