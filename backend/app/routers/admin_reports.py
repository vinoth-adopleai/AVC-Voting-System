"""Administrator-only turnout, reconciliation, results and export endpoints."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth_dependencies import require_admin
from app.db.connection import get_db_session
from app.db.models import AuditLogRecord, ElectionRecord, ReportExportRecord, StaffUserRecord
from app.services.reporting import (
    ReportUnavailableError,
    election_is_closed,
    get_final_results,
    get_reconciliation_report,
    get_turnout_report,
)
from app.storage import REPORT_EXPORT_DIR


router = APIRouter(prefix="/admin/reports", tags=["admin reports"])


class ReportExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    election_id: int = Field(gt=0)
    report_type: Literal["TURNOUT", "FINAL_RESULTS", "RECONCILIATION"]
    export_format: Literal["PDF", "XLSX"]


class PublishResultsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    election_id: int = Field(gt=0)


async def _get_election(election_id: int, session: AsyncSession) -> ElectionRecord:
    election = await session.get(ElectionRecord, election_id)
    if election is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "ELECTION_NOT_FOUND", "message": "Selected election was not found"},
        )
    return election


def _not_ready_error(message: str, code: str = "REPORT_NOT_READY") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"code": code, "message": message},
    )


@router.get("/turnout")
async def turnout_report(
    election_id: int = Query(gt=0),
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Return current turnout totals and hourly entry/vote activity."""
    election = await _get_election(election_id, session)
    return await get_turnout_report(session, election)


@router.get("/reconciliation")
async def reconciliation_report(
    election_id: int = Query(gt=0),
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Compare voted voters, valid ballots and submitted vote rows."""
    election = await _get_election(election_id, session)
    return await get_reconciliation_report(session, election)


@router.get("/results")
async def final_results(
    election_id: int = Query(gt=0),
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Return live totals while open and reconciled final totals after close."""
    election = await _get_election(election_id, session)
    try:
        results = await get_final_results(session, election)
    except ReportUnavailableError as exc:
        raise _not_ready_error(str(exc)) from exc
    return {
        "election_id": election.id,
        "election_name": election.name,
        "election_status": election.status,
        **results,
    }


@router.post("/publish")
async def publish_results(
    payload: PublishResultsRequest,
    admin: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Mark results published only after the closed election reconciles."""
    election = await session.scalar(
        select(ElectionRecord)
        .where(ElectionRecord.id == payload.election_id)
        .with_for_update()
    )
    if election is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "ELECTION_NOT_FOUND", "message": "Selected election was not found"},
        )
    if election.status == "PUBLISHED":
        return {"election_id": election.id, "status": election.status}
    if election.status != "CLOSED":
        raise _not_ready_error("Close the election before publishing results.")

    reconciliation = await get_reconciliation_report(session, election)
    if not reconciliation["passed"]:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "RECONCILIATION_FAILED",
                "message": "Results cannot be published until all reconciliation checks pass.",
                "reconciliation": reconciliation,
            },
        )

    election.status = "PUBLISHED"
    session.add(AuditLogRecord(
        actor_id=admin.id,
        action="ELECTION_RESULTS_PUBLISHED",
        entity="elections",
        entity_id=str(election.id),
        details={
            "name": election.name,
            "valid_ballots": reconciliation["valid_ballots"],
            "submitted_votes": reconciliation["submitted_votes"],
        },
    ))
    await session.commit()
    return {"election_id": election.id, "status": election.status}


@router.post("/exports", status_code=status.HTTP_202_ACCEPTED)
async def request_report_export(
    payload: ReportExportRequest,
    admin: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Queue a PDF or XLSX export for the private report worker."""
    election = await _get_election(payload.election_id, session)
    if payload.report_type == "RECONCILIATION" and not election_is_closed(election):
        raise _not_ready_error("Reconciliation exports are available after the election is closed.")
    if payload.report_type == "FINAL_RESULTS":
        try:
            await get_final_results(session, election)
        except ReportUnavailableError as exc:
            raise _not_ready_error(str(exc)) from exc

    job = ReportExportRecord(
        election_id=election.id,
        requested_by=admin.id,
        report_type=payload.report_type,
        export_format=payload.export_format,
        status="QUEUED",
    )
    session.add(job)
    session.add(AuditLogRecord(
        actor_id=admin.id,
        action="REPORT_EXPORT_REQUESTED",
        entity="report_exports",
        details={
            "election_id": election.id,
            "report_type": payload.report_type,
            "export_format": payload.export_format,
        },
    ))
    await session.flush()
    await session.refresh(job)
    await session.commit()
    return _export_job_response(job)


@router.get("/exports/{job_id}")
async def get_report_export_status(
    job_id: UUID,
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    job = await session.get(ReportExportRecord, job_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "EXPORT_NOT_FOUND", "message": "Report export was not found"},
        )
    return _export_job_response(job)


@router.get("/exports/{job_id}/download")
async def download_report_export(
    job_id: UUID,
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> FileResponse:
    job = await session.get(ReportExportRecord, job_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "EXPORT_NOT_FOUND", "message": "Report export was not found"},
        )
    expected_key = f"{job.id}.{job.export_format.lower()}"
    if job.status != "READY" or job.file_key != expected_key:
        raise _not_ready_error("The report export is not ready to download.", "EXPORT_NOT_READY")
    file_path = (REPORT_EXPORT_DIR / expected_key).resolve()
    if file_path.parent != REPORT_EXPORT_DIR.resolve() or not file_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail={"code": "EXPORT_FILE_EXPIRED", "message": "The report file is no longer available"},
        )
    extension = job.export_format.lower()
    media_type = "application/pdf" if extension == "pdf" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    filename = f"election-{job.election_id}-{job.report_type.lower().replace('_', '-')}.{extension}"
    return FileResponse(
        path=file_path,
        media_type=media_type,
        filename=filename,
        headers={"Cache-Control": "private, no-store"},
    )


def _export_job_response(job: ReportExportRecord) -> dict[str, object]:
    return {
        "id": str(job.id),
        "election_id": job.election_id,
        "report_type": job.report_type,
        "export_format": job.export_format,
        "status": job.status,
        "error_message": job.error_message,
        "created_at": job.created_at.isoformat() if isinstance(job.created_at, datetime) else None,
        "download_url": f"/admin/reports/exports/{job.id}/download" if job.status == "READY" else None,
    }
