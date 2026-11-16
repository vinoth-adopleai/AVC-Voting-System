"""Entry officer voter lookup and check-in endpoints."""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth_dependencies import require_entry_officer
from app.db.connection import get_db_session
from app.db.models import AuditLogRecord, ElectionRecord, StaffUserRecord, VoterRecord, VoterStatus
from app.schemas.entry import EntryActionRequest


router = APIRouter(prefix="/entry", tags=["entry"])
UNDO_WINDOW = timedelta(seconds=60)


def _voter_item(voter: VoterRecord) -> dict[str, object]:
    return {
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
    }


async def _open_election(
    session: AsyncSession,
    *,
    lock: bool = False,
) -> ElectionRecord:
    query = (
        select(ElectionRecord)
        .where(ElectionRecord.status == "OPEN")
        .order_by(ElectionRecord.id.desc())
        .limit(1)
    )
    if lock:
        query = query.with_for_update()
    election = await session.scalar(query)
    if election is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "VOTING_NOT_STARTED", "message": "Voting has not started"},
        )
    return election


@router.get("/voters")
async def find_voter(
    serial: str = Query(min_length=1, max_length=20),
    _officer: StaffUserRecord = Depends(require_entry_officer),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Find one voter by exact serial number in the open election."""
    election = await _open_election(session)
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
    return {"election_name": election.name, "voter": _voter_item(voter)}


@router.post("/enter")
async def mark_voter_entered(
    payload: EntryActionRequest,
    officer: StaffUserRecord = Depends(require_entry_officer),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Atomically mark an eligible voter as having entered the venue."""
    election = await _open_election(session, lock=True)
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
    if voter.status != VoterStatus.ELIGIBLE:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "VOTER_ALREADY_PROCESSED", "message": "This voter can no longer be marked as entered"},
        )

    now = datetime.now(timezone.utc)
    voter.status = VoterStatus.ENTERED
    voter.entered_at = now
    voter.entry_allowed_by = officer.id
    session.add(AuditLogRecord(
        actor_id=officer.id,
        action="VOTER_ENTERED",
        entity="voters",
        entity_id=str(voter.id),
        details={"election_id": voter.election_id, "serial_no": voter.serial_no},
    ))
    await session.commit()
    await session.refresh(voter)
    return _voter_item(voter)


@router.post("/undo")
async def undo_voter_entry(
    payload: EntryActionRequest,
    officer: StaffUserRecord = Depends(require_entry_officer),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Undo this officer's entry action while it is within the 60-second window."""
    voter = await session.scalar(
        select(VoterRecord).where(VoterRecord.id == payload.voter_id).with_for_update()
    )
    if voter is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "VOTER_NOT_FOUND", "message": "Voter was not found"},
        )
    now = datetime.now(timezone.utc)
    entered_at = voter.entered_at
    if (
        voter.status != VoterStatus.ENTERED
        or voter.entry_allowed_by != officer.id
        or entered_at is None
        or now - entered_at < timedelta(0)
        or now - entered_at > UNDO_WINDOW
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "ENTRY_UNDO_EXPIRED", "message": "This entry can no longer be undone"},
        )

    voter.status = VoterStatus.ELIGIBLE
    voter.entered_at = None
    voter.entry_allowed_by = None
    session.add(AuditLogRecord(
        actor_id=officer.id,
        action="VOTER_ENTRY_UNDONE",
        entity="voters",
        entity_id=str(voter.id),
        details={"election_id": voter.election_id, "serial_no": voter.serial_no},
    ))
    await session.commit()
    return {"id": voter.id, "serial_no": voter.serial_no, "undone": True}


@router.get("/my-log")
async def my_entry_log(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=8, ge=1, le=50),
    officer: StaffUserRecord = Depends(require_entry_officer),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Return a page of this officer's check-ins and the currently open election."""
    election = await session.scalar(
        select(ElectionRecord)
        .where(ElectionRecord.status == "OPEN")
        .order_by(ElectionRecord.id.desc())
        .limit(1)
    )
    if election is None:
        return {"election": None, "items": [], "page": page, "page_size": page_size, "total": 0}
    voter_filter = (
        VoterRecord.election_id == election.id,
        VoterRecord.entry_allowed_by == officer.id,
        VoterRecord.entered_at.is_not(None),
    )
    total = await session.scalar(
        select(func.count()).select_from(VoterRecord).where(*voter_filter)
    ) or 0
    voters = await session.scalars(
        select(VoterRecord)
        .where(*voter_filter)
        .order_by(VoterRecord.entered_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    return {
        "election": {"id": election.id, "name": election.name},
        "items": [_voter_item(voter) for voter in voters],
        "page": page,
        "page_size": page_size,
        "total": total,
    }
