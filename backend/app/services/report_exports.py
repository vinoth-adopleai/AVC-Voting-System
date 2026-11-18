"""Persistent report export queue and PDF/XLSX renderers."""

import asyncio
import logging
import os
from datetime import timedelta
from io import BytesIO
from pathlib import Path
from uuid import UUID
from xml.sax.saxutils import escape

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.connection import SessionFactory
from app.db.models import ElectionRecord, ReportExportRecord
from app.services.reporting import (
    ReportUnavailableError,
    election_is_closed,
    get_final_results,
    get_reconciliation_report,
    get_turnout_report,
)
from app.storage import REPORT_EXPORT_DIR


logger = logging.getLogger(__name__)
_STALE_JOB_MINUTES = 10
_EXPORT_ERROR = "The report could not be generated. Please request a new export."


async def run_report_export_worker() -> None:
    """Continuously claim persisted export jobs, recovering stale jobs on startup."""
    recovered = False
    while True:
        try:
            if not recovered:
                await _recover_stale_jobs()
                recovered = True
            job_id = await _claim_next_job()
            if job_id is None:
                await asyncio.sleep(1)
                continue
            await _process_job(job_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Report export worker iteration failed")
            await asyncio.sleep(3)


async def _recover_stale_jobs() -> None:
    async with SessionFactory() as session:
        stale_before = func.now() - timedelta(minutes=_STALE_JOB_MINUTES)
        await session.execute(
            update(ReportExportRecord)
            .where(
                ReportExportRecord.status == "RUNNING",
                ReportExportRecord.started_at < stale_before,
            )
            .values(status="QUEUED", started_at=None)
        )
        await session.commit()


async def _claim_next_job() -> UUID | None:
    async with SessionFactory() as session:
        async with session.begin():
            job = await session.scalar(
                select(ReportExportRecord)
                .where(ReportExportRecord.status == "QUEUED")
                .order_by(ReportExportRecord.created_at, ReportExportRecord.id)
                .with_for_update(skip_locked=True)
                .limit(1)
            )
            if job is None:
                return None
            job.status = "RUNNING"
            job.started_at = func.now()
            return job.id


async def _process_job(job_id: UUID) -> None:
    file_key: str | None = None
    temporary_path: Path | None = None
    try:
        async with SessionFactory() as session:
            job = await session.get(ReportExportRecord, job_id)
            if job is None:
                return
            election = await session.get(ElectionRecord, job.election_id)
            if election is None:
                raise ReportUnavailableError("The selected election no longer exists.")
            payload = await _load_payload(session, job, election)
            export_format = job.export_format

        content = await asyncio.to_thread(_render_export, payload, export_format)
        file_key = f"{job_id}.{export_format.lower()}"
        target_path = REPORT_EXPORT_DIR / file_key
        temporary_path = REPORT_EXPORT_DIR / f".{file_key}.tmp"
        await asyncio.to_thread(_write_export_atomically, temporary_path, target_path, content)

        async with SessionFactory() as session:
            job = await session.get(ReportExportRecord, job_id)
            if job is not None and job.status == "RUNNING":
                job.status = "READY"
                job.file_key = file_key
                job.error_message = None
                job.finished_at = func.now()
                await session.commit()
    except ReportUnavailableError as exc:
        await _mark_job_failed(job_id, str(exc))
    except Exception:
        logger.exception("Report export job %s failed", job_id)
        await _mark_job_failed(job_id, _EXPORT_ERROR)
        if file_key:
            (REPORT_EXPORT_DIR / file_key).unlink(missing_ok=True)
        if temporary_path:
            temporary_path.unlink(missing_ok=True)


async def _load_payload(
    session: AsyncSession,
    job: ReportExportRecord,
    election: ElectionRecord,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "report_type": job.report_type,
        "election": {
            "id": election.id,
            "name": election.name,
            "date": election.election_date.isoformat(),
            "status": election.status,
            "ballot_total": election.ballot_total,
        },
    }
    if job.report_type == "TURNOUT":
        payload["turnout"] = await get_turnout_report(session, election)
        return payload

    if job.report_type == "RECONCILIATION":
        if not election_is_closed(election):
            raise ReportUnavailableError("Reconciliation exports are available after the election is closed.")
        reconciliation = await get_reconciliation_report(session, election)
        payload["reconciliation"] = reconciliation
        return payload

    results_report = await get_final_results(session, election)
    payload["results"] = results_report["results"]
    if election_is_closed(election):
        payload["reconciliation"] = await get_reconciliation_report(session, election)
    payload["turnout"] = await get_turnout_report(session, election)
    return payload


async def _mark_job_failed(job_id: UUID, message: str) -> None:
    async with SessionFactory() as session:
        job = await session.get(ReportExportRecord, job_id)
        if job is not None:
            job.status = "FAILED"
            job.error_message = message
            job.finished_at = func.now()
            await session.commit()


def _write_export_atomically(temporary_path, target_path, content: bytes) -> None:
    REPORT_EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    temporary_path.write_bytes(content)
    os.replace(temporary_path, target_path)


def _render_export(payload: dict[str, object], export_format: str) -> bytes:
    if export_format == "PDF":
        return _render_pdf(payload)
    return _render_xlsx(payload)


def _render_xlsx(payload: dict[str, object]) -> bytes:
    workbook = Workbook()
    summary = workbook.active
    summary.title = "Summary"
    election = payload["election"]
    summary.append(["Election report", election["name"]])
    summary.append(["Election date", election["date"]])
    summary.append(["Election status", election["status"]])
    summary.append(["Report type", payload["report_type"].replace("_", " ").title()])

    turnout = payload.get("turnout")
    if turnout:
        summary.append([])
        summary.append(["Voter status", "Count"])
        for label, key in (
            ("Total voters", "total_voters"),
            ("Entered, not voted", "entered_voters"),
            ("Voted", "voted_voters"),
            ("Not entered", "not_entered_voters"),
        ):
            summary.append([label, turnout["summary"][key]])
        hourly = workbook.create_sheet("Turnout by hour")
        hourly.append(["Hour", "Entered", "Voted"])
        for item in turnout["hourly"]:
            hourly.append([item["hour"], item["entered"], item["voted"]])

    reconciliation = payload.get("reconciliation")
    if reconciliation:
        sheet = workbook.create_sheet("Reconciliation")
        sheet.append(["Check", "Actual", "Expected", "Passed"])
        sheet.append([
            "Voted voters match valid ballots",
            reconciliation["voted_voters"],
            reconciliation["valid_ballots"],
            reconciliation["checks"]["voted_voters_match_valid_ballots"],
        ])
        sheet.append([
            "Submitted votes match ballot total",
            reconciliation["submitted_votes"],
            reconciliation["expected_votes"],
            reconciliation["checks"]["vote_rows_match_ballot_total"],
        ])

    results = payload.get("results")
    if results is not None:
        sheet = workbook.create_sheet("Results")
        sheet.append([
            "Position order", "Position (English)", "Position (Tamil)", "Ballot number",
            "Candidate (English)", "Candidate (Tamil)", "Votes",
        ])
        for result in results:
            sheet.append([
                result["display_order"],
                result["position_name"],
                result["position_name_ta"],
                result["ballot_no"],
                result["candidate_en"],
                result["candidate_ta"],
                result["vote_count"],
            ])

    header_fill = PatternFill("solid", fgColor="EAF0F5")
    for sheet in workbook.worksheets:
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions if sheet.max_row > 1 else "A1"
        for cell in sheet[1]:
            cell.font = Font(bold=True, color="20374D")
            cell.fill = header_fill
        for column_cells in sheet.columns:
            column_letter = column_cells[0].column_letter
            max_width = max((len(str(cell.value or "")) for cell in column_cells), default=10)
            sheet.column_dimensions[column_letter].width = min(max(max_width + 2, 12), 42)
        for row in sheet.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = Alignment(vertical="top")

    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


def _render_pdf(payload: dict[str, object]) -> bytes:
    output = BytesIO()
    election = payload["election"]
    election_label = _pdf_safe_text(election["name"], f"Election {election['id']}")
    document = SimpleDocTemplate(
        output,
        pagesize=landscape(A4),
        rightMargin=14 * mm,
        leftMargin=14 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title=f"Election report - {election_label}",
    )
    styles = getSampleStyleSheet()
    body = styles["BodyText"]
    body.fontSize = 9
    body.leading = 12
    story = [
        Paragraph("Election report", styles["Title"]),
        Paragraph(
            f"Election: {escape(election_label)}",
            body,
        ),
        Paragraph(f"Date: {escape(str(election['date']))} | Status: {escape(str(election['status']))}", body),
    ]
    result_rows = payload.get("results") or []
    has_non_ascii_names = not str(election["name"] or "").isascii() or any(
        not str(value or "").isascii()
        for result in result_rows
        for value in (
            result["position_name"],
            result["position_name_ta"],
            result["candidate_en"],
            result["candidate_ta"],
        )
    )
    if has_non_ascii_names:
        story.append(Paragraph("Tamil names are preserved in the Excel export.", body))
    story.append(Spacer(1, 8))

    turnout = payload.get("turnout")
    if turnout:
        summary = turnout["summary"]
        story.extend([
            Paragraph("Voter turnout", styles["Heading2"]),
            _pdf_table([
                ["Total voters", "Entered, not voted", "Voted", "Not entered"],
                [summary["total_voters"], summary["entered_voters"], summary["voted_voters"], summary["not_entered_voters"]],
            ]),
        ])
        if turnout["hourly"]:
            story.extend([
                Spacer(1, 8),
                Paragraph("Turnout by hour", styles["Heading3"]),
                _pdf_table([["Hour", "Entered", "Voted"], *[
                    [item["hour"], item["entered"], item["voted"]]
                    for item in turnout["hourly"]
                ]]),
            ])

    reconciliation = payload.get("reconciliation")
    if reconciliation:
        story.extend([
            Spacer(1, 12),
            Paragraph("Reconciliation", styles["Heading2"]),
            _pdf_table([
                ["Check", "Actual", "Expected", "Result"],
                ["Voted voters / valid ballots", reconciliation["voted_voters"], reconciliation["valid_ballots"], "PASS" if reconciliation["checks"]["voted_voters_match_valid_ballots"] else "FAIL"],
                ["Submitted votes / expected votes", reconciliation["submitted_votes"], reconciliation["expected_votes"], "PASS" if reconciliation["checks"]["vote_rows_match_ballot_total"] else "FAIL"],
            ]),
        ])

    results = payload.get("results")
    if results is not None:
        story.extend([
            Spacer(1, 12),
            Paragraph("Final results", styles["Heading2"]),
            _pdf_table([
                ["Position", "Ballot no.", "Candidate", "Votes"],
                *[
                    [
                        _pdf_safe_text(result["position_name"], "Position"),
                        result["ballot_no"],
                        _pdf_safe_text(
                            result["candidate_en"],
                            f"Candidate {result['ballot_no']}",
                        ),
                        result["vote_count"],
                    ]
                    for result in results
                ],
            ]),
        ])

    document.build(story)
    return output.getvalue()


def _pdf_safe_text(value: object, fallback: str) -> str:
    """Avoid unsupported glyphs in ReportLab's built-in Helvetica fonts."""
    text = str(value or "")
    return text if text.isascii() else fallback


def _pdf_table(rows: list[list[object]]) -> Table:
    table = Table(rows, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EAF0F5")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#30465A")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#DCE4EC")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table
