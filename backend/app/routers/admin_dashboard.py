"""Administrator-only election voter dashboard endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth_dependencies import require_admin
from app.db.connection import get_db_session
from app.db.models import ElectionRecord, StaffUserRecord
from app.db.views import ThokuthiGenderCountView, VoterSummaryView


router = APIRouter(prefix="/admin/dashboard/voters", tags=["admin dashboard"])


async def _require_election(election_id: int, session: AsyncSession) -> None:
    if await session.get(ElectionRecord, election_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "ELECTION_NOT_FOUND", "message": "Selected election was not found"},
        )


@router.get("/summary")
async def get_voter_summary(
    election_id: int = Query(gt=0),
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, int]:
    """Return voter status totals for one election."""
    await _require_election(election_id, session)
    summary = await session.scalar(
        select(VoterSummaryView).where(VoterSummaryView.election_id == election_id)
    )
    if summary is None:
        return {
            "election_id": election_id,
            "total_voters": 0,
            "entered_voters": 0,
            "voted_voters": 0,
            "not_entered_voters": 0,
        }
    return {
        "election_id": summary.election_id,
        "total_voters": summary.total_voters,
        "entered_voters": summary.entered_voters,
        "voted_voters": summary.voted_voters,
        "not_entered_voters": summary.not_entered_voters,
    }


@router.get("/thokuthi-gender")
async def get_thokuthi_gender_counts(
    election_id: int = Query(gt=0),
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Return voter counts grouped by Thokuthi and gender for one election."""
    await _require_election(election_id, session)
    rows = await session.scalars(
        select(ThokuthiGenderCountView)
        .where(ThokuthiGenderCountView.election_id == election_id)
        .order_by(ThokuthiGenderCountView.thokuthi, ThokuthiGenderCountView.gender)
    )
    return {
        "election_id": election_id,
        "items": [
            {
                "thokuthi": row.thokuthi or None,
                "gender": row.gender or None,
                "voter_count": row.voter_count,
            }
            for row in rows
        ],
    }
