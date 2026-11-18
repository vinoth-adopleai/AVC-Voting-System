"""Election-scoped report queries and publication checks."""

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    BallotRecord,
    ElectionRecord,
    PositionRecord,
    VoterRecord,
    VoterStatus,
    VoteRecord,
)
from app.db.views import ElectionResultsView, VoterSummaryView


class ReportUnavailableError(Exception):
    """Raised when a report is requested before its release conditions are met."""


def election_is_closed(election: ElectionRecord) -> bool:
    return election.status in {"CLOSED", "PUBLISHED"}


async def get_voter_summary(session: AsyncSession, election_id: int) -> dict[str, int]:
    summary = await session.scalar(
        select(VoterSummaryView).where(VoterSummaryView.election_id == election_id)
    )
    if summary is None:
        return {
            "total_voters": 0,
            "entered_voters": 0,
            "voted_voters": 0,
            "not_entered_voters": 0,
        }
    return {
        "total_voters": summary.total_voters,
        "entered_voters": summary.entered_voters,
        "voted_voters": summary.voted_voters,
        "not_entered_voters": summary.not_entered_voters,
    }


async def get_turnout_report(session: AsyncSession, election: ElectionRecord) -> dict[str, object]:
    entry_hour = func.date_trunc("hour", VoterRecord.entered_at)
    vote_hour = func.date_trunc("hour", VoterRecord.voted_at)
    entry_rows = await session.execute(
        select(entry_hour.label("hour"), func.count(VoterRecord.id).label("count"))
        .where(VoterRecord.election_id == election.id, VoterRecord.entered_at.is_not(None))
        .group_by(entry_hour)
        .order_by(entry_hour)
    )
    vote_rows = await session.execute(
        select(vote_hour.label("hour"), func.count(VoterRecord.id).label("count"))
        .where(VoterRecord.election_id == election.id, VoterRecord.voted_at.is_not(None))
        .group_by(vote_hour)
        .order_by(vote_hour)
    )

    hourly: dict[datetime, dict[str, int]] = {}
    for hour, count in entry_rows:
        hourly.setdefault(hour, {"entered": 0, "voted": 0})["entered"] = count
    for hour, count in vote_rows:
        hourly.setdefault(hour, {"entered": 0, "voted": 0})["voted"] = count

    return {
        "election_id": election.id,
        "election_name": election.name,
        "election_status": election.status,
        "summary": await get_voter_summary(session, election.id),
        "hourly": [
            {"hour": hour.isoformat(), **counts}
            for hour, counts in sorted(hourly.items())
        ],
    }


async def get_reconciliation_report(
    session: AsyncSession,
    election: ElectionRecord,
) -> dict[str, object]:
    voted_voters = await session.scalar(
        select(func.count(VoterRecord.id)).where(
            VoterRecord.election_id == election.id,
            VoterRecord.status == VoterStatus.VOTED,
        )
    ) or 0
    valid_ballots = await session.scalar(
        select(func.count(BallotRecord.id)).where(
            BallotRecord.election_id == election.id,
            BallotRecord.status == "SUBMITTED",
        )
    ) or 0
    submitted_votes = await session.scalar(
        select(func.count(VoteRecord.id))
        .join(BallotRecord, BallotRecord.id == VoteRecord.ballot_id)
        .where(
            BallotRecord.election_id == election.id,
            BallotRecord.status == "SUBMITTED",
        )
    ) or 0
    expected_votes = valid_ballots * election.ballot_total
    checks = {
        "voted_voters_match_valid_ballots": voted_voters == valid_ballots,
        "vote_rows_match_ballot_total": submitted_votes == expected_votes,
    }
    passed = all(checks.values())
    closed = election_is_closed(election)
    return {
        "election_id": election.id,
        "election_status": election.status,
        "is_closed": closed,
        "voted_voters": voted_voters,
        "valid_ballots": valid_ballots,
        "submitted_votes": submitted_votes,
        "expected_votes": expected_votes,
        "ballot_total": election.ballot_total,
        "checks": checks,
        "passed": passed,
        "ready_to_publish": closed and passed,
    }


async def get_final_results(
    session: AsyncSession,
    election: ElectionRecord,
) -> dict[str, list[dict[str, object]]]:
    if election.status not in {"OPEN", "CLOSED", "PUBLISHED"}:
        raise ReportUnavailableError("Results are available once the election is open.")
    if election_is_closed(election):
        reconciliation = await get_reconciliation_report(session, election)
        if not reconciliation["passed"]:
            raise ReportUnavailableError("Results are hidden until election reconciliation passes.")

    positions = await session.scalars(
        select(PositionRecord)
        .where(PositionRecord.election_id == election.id)
        .order_by(PositionRecord.display_order)
    )
    position_rows = [
        {
            "position_id": position.id,
            "position_name": position.name_en,
            "position_name_ta": position.name_ta,
            "display_order": position.display_order,
            "candidates": [],
        }
        for position in positions
    ]
    positions_by_id = {position["position_id"]: position for position in position_rows}

    rows = await session.scalars(
        select(ElectionResultsView)
        .where(ElectionResultsView.election_id == election.id)
        .order_by(
            ElectionResultsView.display_order,
            ElectionResultsView.vote_count.desc(),
            ElectionResultsView.ballot_no,
        )
    )
    flat_results: list[dict[str, object]] = []
    for row in rows:
        result = {
            "position_id": row.position_id,
            "position_name": row.position_name,
            "position_name_ta": row.position_name_ta,
            "display_order": row.display_order,
            "candidate_id": row.candidate_id,
            "ballot_no": row.ballot_no,
            "candidate_ta": row.candidate_ta,
            "candidate_en": row.candidate_en,
            "photo_url": row.photo_url,
            "vote_count": row.vote_count,
        }
        flat_results.append(result)
        position = positions_by_id.get(row.position_id)
        if position is not None:
            position["candidates"].append(result)

    return {"positions": position_rows, "results": flat_results}
