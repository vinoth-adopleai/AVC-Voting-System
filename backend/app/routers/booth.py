"""Voting terminal session and ballot submission endpoints."""

import hashlib
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.connection import get_db_session
from app.db.models import (
    AuditLogRecord,
    BallotRecord,
    CandidateRecord,
    ElectionRecord,
    IdempotencyKeyRecord,
    PositionRecord,
    SystemStatus,
    VoteRecord,
    VoterRecord,
    VoterStatus,
    VotingSystemRecord,
)


router = APIRouter(prefix="/booth", tags=["voting terminal"])
BALLOT_ENDPOINT = "POST:/booth/ballot"


class PositionSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    position_id: int = Field(gt=0)
    candidate_ids: list[int] = Field(min_length=1, max_length=5)


class BallotSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid")

    idempotency_key: UUID
    selections: list[PositionSelection] = Field(min_length=7, max_length=7)


async def _system_from_token(
    authorization: str | None,
    session: AsyncSession,
    *,
    lock: bool = False,
) -> VotingSystemRecord:
    scheme, _, raw_token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not raw_token.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "DEVICE_TOKEN_REQUIRED", "message": "Voting system token is required"},
            headers={"WWW-Authenticate": "Bearer"},
        )
    token_hash = hashlib.sha256(raw_token.strip().encode("utf-8")).hexdigest()
    query = select(VotingSystemRecord).where(VotingSystemRecord.token_hash == token_hash)
    if lock:
        query = query.with_for_update()
    system = await session.scalar(query)
    if system is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "INVALID_DEVICE_TOKEN", "message": "Voting system token is invalid"},
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not system.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "DEVICE_DISABLED", "message": "This voting system is disabled"},
        )
    return system


async def _ballot_setup(
    session: AsyncSession,
    election: ElectionRecord,
) -> list[dict[str, object]]:
    positions = list(await session.scalars(
        select(PositionRecord)
        .where(PositionRecord.election_id == election.id)
        .order_by(PositionRecord.display_order, PositionRecord.id)
    ))
    if len(positions) != 7 or sum(position.max_choices for position in positions) != election.ballot_total:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "BALLOT_CONFIGURATION_INVALID",
                "message": "This election must have seven positions and position vote limits totaling the election ballot total",
            },
        )

    result: list[dict[str, object]] = []
    for position in positions:
        candidates = list(await session.scalars(
            select(CandidateRecord)
            .where(
                CandidateRecord.position_id == position.id,
                CandidateRecord.is_active.is_(True),
            )
            .order_by(func.lower(CandidateRecord.name_ta), func.lower(CandidateRecord.name_en), CandidateRecord.id)
        ))
        if len(candidates) < position.max_choices:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "POSITION_CANDIDATES_INSUFFICIENT",
                    "message": f"Position {position.name_en} does not have enough active candidates",
                },
            )
        result.append({
            "id": position.id,
            "name_ta": position.name_ta,
            "name_en": position.name_en,
            "min_choices": position.min_choices,
            "max_choices": position.max_choices,
            "candidates": [
                {
                    "id": candidate.id,
                    "name_ta": candidate.name_ta,
                    "name_en": candidate.name_en,
                    "photo_url": candidate.photo_url,
                }
                for candidate in candidates
            ],
        })
    return result


@router.get("/session")
async def get_terminal_session(
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Poll a registered terminal and return the assigned voter's ballot when ready."""
    system = await _system_from_token(authorization, session)
    system.last_seen_at = datetime.now(timezone.utc)
    if system.status == SystemStatus.OFFLINE:
        await session.commit()
        return {"state": "LOCKED", "reason": "SYSTEM_OFFLINE"}
    if system.current_voter_id is None or system.status != SystemStatus.OCCUPIED:
        await session.commit()
        return {"state": "LOCKED"}

    election = await session.get(ElectionRecord, system.election_id)
    voter = await session.get(VoterRecord, system.current_voter_id)
    if election is None or election.status != "OPEN":
        await session.commit()
        return {"state": "LOCKED", "reason": "ELECTION_NOT_OPEN"}
    if voter is None or voter.election_id != election.id or voter.status != VoterStatus.BOOTH_ASSIGNED:
        await session.commit()
        return {"state": "LOCKED", "reason": "VOTER_NOT_ASSIGNED"}

    positions = await _ballot_setup(session, election)
    await session.commit()
    return {
        "state": "BALLOT",
        "election": {"id": election.id, "name": election.name, "ballot_total": election.ballot_total},
        "position_count": len(positions),
        "positions": positions,
    }


@router.post("/ballot")
async def submit_terminal_ballot(
    payload: BallotSubmission,
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Validate and commit one immutable ballot for the voter assigned to this terminal."""
    system = await _system_from_token(authorization, session, lock=True)
    key = str(payload.idempotency_key)
    previous = await session.get(IdempotencyKeyRecord, (BALLOT_ENDPOINT, key))
    if previous is not None:
        if previous.system_id != system.id or previous.response is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "IDEMPOTENCY_KEY_REUSED", "message": "This ballot request key has already been used"},
            )
        await session.commit()
        return {**previous.response, "idempotent": True}

    if system.status != SystemStatus.OCCUPIED or system.current_voter_id is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "NO_ASSIGNED_VOTER", "message": "No voter is currently assigned to this voting system"},
        )
    election = await session.get(ElectionRecord, system.election_id, with_for_update=True)
    voter = await session.scalar(
        select(VoterRecord).where(VoterRecord.id == system.current_voter_id).with_for_update()
    )
    if election is None or election.status != "OPEN":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "ELECTION_NOT_OPEN", "message": "Voting is not open for this election"},
        )
    if voter is None or voter.election_id != election.id or voter.status != VoterStatus.BOOTH_ASSIGNED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "VOTER_STATE_CONFLICT", "message": "The assigned voter is not ready to vote"},
        )

    positions = list(await session.scalars(
        select(PositionRecord)
        .where(PositionRecord.election_id == election.id)
        .order_by(PositionRecord.display_order, PositionRecord.id)
    ))
    selected_position_ids = [selection.position_id for selection in payload.selections]
    if len(positions) != 7 or len(set(selected_position_ids)) != 7:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_POSITION_SELECTIONS", "message": "Submit one selection for each of the seven positions"},
        )
    positions_by_id = {position.id: position for position in positions}
    if set(selected_position_ids) != set(positions_by_id):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_POSITION_SELECTIONS", "message": "Selections must match all positions in this election"},
        )

    vote_pairs: list[tuple[int, int]] = []
    for selection in payload.selections:
        position = positions_by_id[selection.position_id]
        if len(selection.candidate_ids) != position.max_choices or len(set(selection.candidate_ids)) != len(selection.candidate_ids):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "code": "INVALID_CHOICE_COUNT",
                    "message": f"Select exactly {position.max_choices} candidate(s) for {position.name_en}",
                },
            )
        active_candidates = set(await session.scalars(
            select(CandidateRecord.id).where(
                CandidateRecord.position_id == position.id,
                CandidateRecord.id.in_(selection.candidate_ids),
                CandidateRecord.is_active.is_(True),
            )
        ))
        if active_candidates != set(selection.candidate_ids):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"code": "INVALID_CANDIDATE_SELECTION", "message": "A selected candidate is unavailable for that position"},
            )
        vote_pairs.extend((position.id, candidate_id) for candidate_id in selection.candidate_ids)

    if len(vote_pairs) != election.ballot_total:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "BALLOT_TOTAL_MISMATCH", "message": "Position limits do not match the election ballot total"},
        )

    ballot = BallotRecord(
        election_id=election.id,
        voter_id=voter.id,
        system_id=system.id,
        authorized_by=voter.vote_allowed_by,
        status="SUBMITTED",
    )
    session.add(ballot)
    await session.flush()
    session.add_all([
        VoteRecord(ballot_id=ballot.id, position_id=position_id, candidate_id=candidate_id)
        for position_id, candidate_id in vote_pairs
    ])
    voter.status = VoterStatus.VOTED
    voter.voted_at = datetime.now(timezone.utc)
    system.status = SystemStatus.FREE
    system.current_voter_id = None
    session.add(AuditLogRecord(
        system_id=system.id,
        action="BALLOT_SUBMITTED",
        entity="ballots",
        entity_id=str(ballot.id),
        details={"election_id": election.id, "voter_id": voter.id, "vote_count": len(vote_pairs)},
    ))
    response = {"status": "SUBMITTED", "ballot_id": ballot.id, "vote_count": len(vote_pairs)}
    session.add(IdempotencyKeyRecord(
        endpoint=BALLOT_ENDPOINT,
        key=key,
        system_id=system.id,
        status_code=status.HTTP_201_CREATED,
        response=response,
    ))
    try:
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    return response
