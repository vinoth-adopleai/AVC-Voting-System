"""Booth officer and supervisor board, queue, assignment, and reset endpoints."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth_dependencies import require_booth_staff
from app.db.connection import get_db_session
from app.db.models import (
    AuditLogRecord,
    BallotRecord,
    ElectionRecord,
    MonitorDeskRecord,
    StaffRole,
    StaffUserRecord,
    SystemStatus,
    VoterRecord,
    VoterStatus,
    VotingSystemRecord,
)
from app.schemas.systems import BoothAssignmentRequest


router = APIRouter(prefix="/monitor", tags=["booth operations"])


async def _get_open_election(session: AsyncSession) -> ElectionRecord:
    election = await session.scalar(
        select(ElectionRecord)
        .where(ElectionRecord.status == "OPEN")
        .order_by(ElectionRecord.id.desc())
        .limit(1)
    )
    if election is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "VOTING_NOT_STARTED", "message": "Voting has not started"},
        )
    return election


async def _managed_booths(
    officer: StaffUserRecord,
    election_id: int,
    session: AsyncSession,
) -> list[MonitorDeskRecord]:
    assigned_column = (
        MonitorDeskRecord.supervisor_id
        if officer.role == StaffRole.MONITOR_SUPERVISOR
        else MonitorDeskRecord.officer_id
    )
    booths = await session.scalars(
        select(MonitorDeskRecord)
        .where(
            MonitorDeskRecord.election_id == election_id,
            assigned_column == officer.id,
        )
        .order_by(MonitorDeskRecord.desk_no)
    )
    return list(booths)


@router.get("/board")
async def booth_board(
    officer: StaffUserRecord = Depends(require_booth_staff),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Return systems only for booths assigned to the authenticated booth staff member."""
    election = await _get_open_election(session)
    booths = await _managed_booths(officer, election.id, session)
    if not booths:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "BOOTH_NOT_ASSIGNED", "message": "No booth is assigned to your account"},
        )

    booth_ids = [booth.id for booth in booths]
    systems = list(await session.scalars(
        select(VotingSystemRecord)
        .where(VotingSystemRecord.monitor_desk_id.in_(booth_ids))
        .order_by(VotingSystemRecord.monitor_desk_id, VotingSystemRecord.system_no)
    ))
    voter_ids = [system.current_voter_id for system in systems if system.current_voter_id is not None]
    voters_by_id: dict[int, VoterRecord] = {}
    if voter_ids:
        voters = await session.scalars(select(VoterRecord).where(VoterRecord.id.in_(voter_ids)))
        voters_by_id = {voter.id: voter for voter in voters}

    systems_by_booth: dict[int, list[dict[str, object]]] = {booth.id: [] for booth in booths}
    for system in systems:
        voter = voters_by_id.get(system.current_voter_id) if system.current_voter_id is not None else None
        systems_by_booth[system.monitor_desk_id].append({
            "id": system.id,
            "system_no": system.system_no,
            "name": system.name,
            "status": system.status.value if isinstance(system.status, SystemStatus) else system.status,
            "is_active": system.is_active,
            "last_seen_at": system.last_seen_at,
            "current_voter_id": system.current_voter_id,
            "voter": ({"id": voter.id, "serial_no": voter.serial_no, "name": voter.name} if voter else None),
        })

    return {
        "election_id": election.id,
        "election_name": election.name,
        "role": officer.role.value,
        "booths": [
            {
                "id": booth.id,
                "booth_no": booth.desk_no,
                "systems": systems_by_booth[booth.id],
            }
            for booth in booths
        ],
    }


@router.get("/waiting")
async def waiting_voters(
    search: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=6, ge=1, le=50),
    officer: StaffUserRecord = Depends(require_booth_staff),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """List voters who have entered but have not yet been assigned to a system."""
    election = await _get_open_election(session)
    booths = await _managed_booths(officer, election.id, session)
    if not booths:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "BOOTH_NOT_ASSIGNED", "message": "No booth is assigned to your account"},
        )

    voter_filters = [
        VoterRecord.election_id == election.id,
        VoterRecord.status == VoterStatus.ENTERED,
        VoterRecord.entered_at.is_not(None),
        VoterRecord.entry_allowed_by.is_not(None),
    ]
    search_text = search.strip() if search else ""
    if search_text:
        voter_filters.append(or_(
            func.lower(VoterRecord.serial_no) == search_text.casefold(),
            VoterRecord.name.ilike(f"%{search_text}%"),
        ))
    total = await session.scalar(
        select(func.count()).select_from(VoterRecord).where(*voter_filters)
    ) or 0
    voters = await session.scalars(
        select(VoterRecord)
        .where(*voter_filters)
        .order_by(VoterRecord.entered_at.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    items = []
    for voter in voters:
        entered_at = voter.entered_at
        items.append({
            "id": voter.id,
            "serial_no": voter.serial_no,
            "name": voter.name,
            "father_husband_name": voter.father_husband_name,
            "age": voter.age,
            "gender": voter.gender,
            "address": voter.address,
            "status": voter.status.value if isinstance(voter.status, VoterStatus) else voter.status,
            "entered_at": entered_at,
        })
    return {
        "election_id": election.id,
        "election_name": election.name,
        "items": items,
        "page": page,
        "page_size": page_size,
        "total": total,
    }


@router.get("/voters")
async def find_booth_voter(
    serial: str = Query(min_length=1, max_length=20),
    officer: StaffUserRecord = Depends(require_booth_staff),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Look up a voter in the open election for booth officer verification."""
    election = await _get_open_election(session)
    booths = await _managed_booths(officer, election.id, session)
    if not booths:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "BOOTH_NOT_ASSIGNED", "message": "No booth is assigned to your account"},
        )
    serial_no = serial.strip()
    if not serial_no:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "SERIAL_REQUIRED", "message": "Enter a voter serial number"},
        )
    voter = await session.scalar(
        select(VoterRecord).where(
            VoterRecord.election_id == election.id,
            func.lower(VoterRecord.serial_no) == serial_no.casefold(),
        )
    )
    if voter is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "VOTER_NOT_FOUND", "message": "Voter is not on the list for this election"},
        )
    if voter.status == VoterStatus.VOTED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "VOTER_ALREADY_VOTED",
                "message": "This voter has already voted",
            },
        )
    if voter.status == VoterStatus.BOOTH_ASSIGNED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "VOTER_ALREADY_ASSIGNED",
                "message": "This voter has already been assigned to a voting system",
            },
        )
    if (
        voter.status != VoterStatus.ENTERED
        or voter.entered_at is None
        or voter.entry_allowed_by is None
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "VOTER_NOT_ENTERED",
                "message": "This voter has not been marked as entered at the entry desk",
            },
        )
    return {
        "election_name": election.name,
        "voter": {
            "id": voter.id,
            "serial_no": voter.serial_no,
            "name": voter.name,
            "photo": voter.photo,
            "father_husband_name": voter.father_husband_name,
            "age": voter.age,
            "gender": voter.gender,
            "address": voter.address,
            "status": voter.status.value if isinstance(voter.status, VoterStatus) else voter.status,
            "entered_at": voter.entered_at,
        },
    }


@router.post("/assign")
async def assign_voter_to_system(
    payload: BoothAssignmentRequest,
    officer: StaffUserRecord = Depends(require_booth_staff),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Assign an entered voter to a free system in one of this user's booths."""
    election = await _get_open_election(session)
    booths = await _managed_booths(officer, election.id, session)
    booth_ids = {booth.id for booth in booths}
    if not booth_ids:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "BOOTH_NOT_ASSIGNED", "message": "No booth is assigned to your account"},
        )

    system = await session.scalar(
        select(VotingSystemRecord).where(
            VotingSystemRecord.id == payload.system_id,
            VotingSystemRecord.election_id == election.id,
        ).with_for_update()
    )
    if system is None or system.monitor_desk_id not in booth_ids:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "SYSTEM_NOT_IN_ASSIGNED_BOOTH", "message": "This voting system is not in your assigned booth"},
        )
    if not system.is_active or system.status != SystemStatus.FREE or system.current_voter_id is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "SYSTEM_NOT_AVAILABLE", "message": "This voting system is not available"},
        )

    voter = await session.scalar(
        select(VoterRecord).where(
            VoterRecord.id == payload.voter_id,
            VoterRecord.election_id == election.id,
        ).with_for_update()
    )
    if voter is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "VOTER_NOT_FOUND", "message": "Voter was not found"},
        )
    if voter.status != VoterStatus.ENTERED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "VOTER_NOT_WAITING", "message": "This voter is no longer waiting for a voting system"},
        )

    voter.status = VoterStatus.BOOTH_ASSIGNED
    voter.vote_allowed_by = officer.id
    system.status = SystemStatus.OCCUPIED
    system.current_voter_id = voter.id
    session.add(AuditLogRecord(
        actor_id=officer.id,
        system_id=system.id,
        action="VOTER_ASSIGNED_TO_SYSTEM",
        entity="voters",
        entity_id=str(voter.id),
        details={"election_id": election.id, "serial_no": voter.serial_no, "system_no": system.system_no},
    ))
    await session.commit()
    return {
        "voter_id": voter.id,
        "serial_no": voter.serial_no,
        "name": voter.name,
        "system_id": system.id,
        "system_no": system.system_no,
        "booth_no": next(booth.desk_no for booth in booths if booth.id == system.monitor_desk_id),
    }


@router.post("/systems/{system_id}/reset")
async def reset_voting_system(
    system_id: int,
    officer: StaffUserRecord = Depends(require_booth_staff),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Free an occupied system and return its voter to the entered queue if no ballot exists."""
    election = await _get_open_election(session)
    booths = await _managed_booths(officer, election.id, session)
    booth_ids = {booth.id for booth in booths}
    system = await session.scalar(
        select(VotingSystemRecord).where(
            VotingSystemRecord.id == system_id,
            VotingSystemRecord.election_id == election.id,
        ).with_for_update()
    )
    if system is None or system.monitor_desk_id not in booth_ids:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "SYSTEM_NOT_IN_ASSIGNED_BOOTH", "message": "This voting system is not in your assigned booth"},
        )
    if system.status != SystemStatus.OCCUPIED or system.current_voter_id is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "SYSTEM_NOT_OCCUPIED", "message": "This voting system is not occupied"},
        )

    voter = await session.scalar(
        select(VoterRecord).where(VoterRecord.id == system.current_voter_id).with_for_update()
    )
    if voter is None or voter.status != VoterStatus.BOOTH_ASSIGNED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "VOTER_STATE_CONFLICT", "message": "The assigned voter cannot be returned to the waiting queue"},
        )
    submitted_ballot = await session.scalar(
        select(BallotRecord.id).where(
            BallotRecord.election_id == election.id,
            BallotRecord.voter_id == voter.id,
            BallotRecord.status == "SUBMITTED",
        ).limit(1)
    )
    if submitted_ballot is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "BALLOT_ALREADY_SUBMITTED", "message": "A submitted ballot cannot be reset"},
        )

    voter.status = VoterStatus.ENTERED
    voter.vote_allowed_by = None
    system.status = SystemStatus.FREE
    system.current_voter_id = None
    session.add(AuditLogRecord(
        actor_id=officer.id,
        system_id=system.id,
        action="VOTING_SYSTEM_RESET",
        entity="voters",
        entity_id=str(voter.id),
        details={"election_id": election.id, "serial_no": voter.serial_no, "system_no": system.system_no},
    ))
    await session.commit()
    return {"system_id": system.id, "system_no": system.system_no, "status": "FREE", "voter_id": voter.id}
