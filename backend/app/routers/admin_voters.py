"""Administrator voter CSV import endpoints."""

import csv
import io
import re

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth_dependencies import require_admin
from app.db.connection import get_db_session
from app.db.models import ElectionRecord, StaffUserRecord, VoterRecord, VoterStatus


router = APIRouter(prefix="/admin/voters", tags=["admin voters"])
_VOTER_IMPORT_LOCK_ID = 741_628_451_036
_MAX_CSV_BYTES = 10 * 1024 * 1024
_MAX_CSV_ROWS = 20_000
_REQUIRED_COLUMNS = {"serial_no", "name"}
_OPTIONAL_COLUMNS = {"father_husband_name", "photo", "thokuthi", "age", "gender", "address"}
_IGNORED_COLUMNS = {"status"}
_ALL_COLUMNS = _REQUIRED_COLUMNS | _OPTIONAL_COLUMNS | _IGNORED_COLUMNS
_HEADER_ALIASES = {
    "serialno": "serial_no",
    "serialnumber": "serial_no",
    "sno": "serial_no",
    "voterserialno": "serial_no",
    "voterserialnumber": "serial_no",
    "name": "name",
    "votername": "name",
    "photopath": "photo",
    "voterphotopath": "photo",
    "thokuthi": "thokuthi",
    "thokuthiname": "thokuthi",
    "தொகுதி": "thokuthi",
    "fatherhusbandname": "father_husband_name",
    "fatherorhusbandname": "father_husband_name",
    "fathername": "father_husband_name",
    "husbandname": "father_husband_name",
    "age": "age",
    "gender": "gender",
    "address": "address",
    "status": "status",
}
_GENDER_ALIASES = {
    "m": "M",
    "male": "M",
    "man": "M",
    "ஆண்": "M",
    "f": "F",
    "female": "F",
    "woman": "F",
    "பெண்": "F",
}


def _normalize_header(header: str | None) -> str:
    """Map common human-readable voter CSV headings to database fields."""
    label = header.strip().lower() if header else ""
    compact = re.sub(r"[^a-z0-9]+", "", label)
    return _HEADER_ALIASES.get(label, _HEADER_ALIASES.get(compact, label))


def _parse_csv(data: bytes) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    """Parse and validate rows, returning normalized rows and row errors."""
    try:
        source = io.StringIO(data.decode("utf-8-sig"), newline="")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_CSV_ENCODING", "message": "Save the CSV as UTF-8 and upload it again"},
        ) from exc

    try:
        reader = csv.DictReader(source, strict=True)
        headers = [_normalize_header(header) for header in (reader.fieldnames or [])]
        if not headers:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"code": "CSV_HEADER_REQUIRED", "message": "The CSV must include a header row"},
            )
        if len(headers) != len(set(headers)):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"code": "DUPLICATE_CSV_HEADERS", "message": "CSV column names must be unique"},
            )
        missing = sorted(_REQUIRED_COLUMNS - set(headers))
        unknown = sorted(set(headers) - _ALL_COLUMNS)
        if missing or unknown:
            details = []
            if missing:
                details.append(f"Required columns missing: {', '.join(missing)}")
            if unknown:
                details.append(f"Unknown columns: {', '.join(unknown)}")
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "code": "INVALID_CSV_COLUMNS",
                    "message": "; ".join(details),
                    "expected_columns": ["serial_no", "name", "father_husband_name", "photo", "thokuthi", "age", "gender", "address"],
                },
            )

        normalized_rows: list[dict[str, object]] = []
        errors: list[dict[str, object]] = []
        seen_serial_numbers: set[str] = set()
        for row_number, raw_row in enumerate(reader, start=2):
            if row_number - 1 > _MAX_CSV_ROWS:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail={"code": "CSV_TOO_MANY_ROWS", "message": f"CSV files can contain at most {_MAX_CSV_ROWS:,} voter rows"},
                )
            if raw_row is None or not any((value or "").strip() for value in raw_row.values() if isinstance(value, str)):
                continue

            values = {headers[index]: value for index, value in enumerate(raw_row.values()) if index < len(headers)}
            row_errors: list[str] = []
            if None in raw_row:
                row_errors.append("Row has more values than the header has columns")
            serial_no = (values.get("serial_no") or "").strip()
            name = (values.get("name") or "").strip()
            father_husband_name = (values.get("father_husband_name") or "").strip() or None
            photo = (values.get("photo") or "").strip() or None
            thokuthi = (values.get("thokuthi") or "").strip() or None
            age_value = (values.get("age") or "").strip()
            gender_text = (values.get("gender") or "").strip()
            gender_value = _GENDER_ALIASES.get(gender_text.casefold(), gender_text.upper() if len(gender_text) == 1 else gender_text)
            address = (values.get("address") or "").strip() or None

            for field_name, field_value in (("serial_no", serial_no), ("name", name), ("father_husband_name", father_husband_name or ""), ("photo", photo or ""), ("thokuthi", thokuthi or ""), ("gender", gender_value), ("address", address or "")):
                if "\x00" in field_value:
                    row_errors.append(f"{field_name} cannot contain a null character")

            if not serial_no:
                row_errors.append("serial_no is required")
            elif len(serial_no) > 20:
                row_errors.append("serial_no must be 20 characters or fewer")
            elif serial_no.casefold() in seen_serial_numbers:
                row_errors.append("serial_no is duplicated in this CSV")
            else:
                seen_serial_numbers.add(serial_no.casefold())

            if not name:
                row_errors.append("name is required")
            if age_value:
                try:
                    age = int(age_value)
                    if age < 18 or age > 32_767:
                        row_errors.append("age must be between 18 and 32767")
                except ValueError:
                    age = None
                    row_errors.append("age must be a whole number")
            else:
                age = None
            if len(gender_value) > 1:
                row_errors.append("gender must be M/F, Male/Female, or ஆண்/பெண்")
            if address and len(address) > 2_000:
                row_errors.append("address must be 2000 characters or fewer")
            if father_husband_name and len(father_husband_name) > 2_000:
                row_errors.append("father_husband_name must be 2000 characters or fewer")
            if photo and len(photo) > 2_000:
                row_errors.append("photo must be 2000 characters or fewer")
            if thokuthi and len(thokuthi) > 100:
                row_errors.append("thokuthi must be 100 characters or fewer")

            normalized = {
                "row_number": row_number,
                "serial_no": serial_no,
                "name": name,
                "father_husband_name": father_husband_name,
                "photo": photo,
                "thokuthi": thokuthi,
                "age": age,
                "gender": gender_value or None,
                "address": address,
                "errors": row_errors,
            }
            normalized_rows.append(normalized)
            if row_errors:
                errors.append({"row_number": row_number, "serial_no": serial_no, "name": name, "errors": row_errors})
    except csv.Error as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "MALFORMED_CSV", "message": "The uploaded CSV could not be parsed"},
        ) from exc

    if not normalized_rows:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "CSV_HAS_NO_VOTERS", "message": "The CSV does not contain any voter rows"},
        )
    return normalized_rows, errors


async def _read_csv(file: UploadFile) -> bytes:
    if file.filename and not file.filename.lower().endswith(".csv"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "CSV_FILE_REQUIRED", "message": "Choose a .csv file"},
        )
    data = await file.read(_MAX_CSV_BYTES + 1)
    await file.close()
    if not data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "CSV_EMPTY", "message": "The uploaded CSV is empty"},
        )
    if len(data) > _MAX_CSV_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={"code": "CSV_TOO_LARGE", "message": "CSV files must be 10 MB or smaller"},
        )
    return data


async def _require_draft_election(
    election_id: int,
    session: AsyncSession,
    *,
    lock: bool = False,
) -> ElectionRecord:
    election_query = select(ElectionRecord).where(ElectionRecord.id == election_id)
    if lock:
        election_query = election_query.with_for_update()
    election = await session.scalar(election_query)
    if election is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "ELECTION_NOT_FOUND", "message": "Selected election was not found"},
        )
    if election.status != "DRAFT":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "ELECTION_CONFIGURATION_LOCKED", "message": "Voters can only be imported while the election is a draft"},
        )
    return election


async def _mark_existing_serials(
    election_id: int,
    rows: list[dict[str, object]],
    errors: list[dict[str, object]],
    session: AsyncSession,
) -> None:
    serials = [str(row["serial_no"]) for row in rows if row["serial_no"]]
    if not serials:
        return
    existing = await session.scalars(
        select(VoterRecord.serial_no).where(
            VoterRecord.election_id == election_id,
            func.lower(VoterRecord.serial_no).in_([serial.casefold() for serial in serials]),
        )
    )
    existing_serials = {serial.casefold() for serial in existing}
    for row in rows:
        if row["serial_no"] and str(row["serial_no"]).casefold() in existing_serials:
            row["errors"].append("serial_no already exists for this election")
    errors[:] = [{
                "row_number": row["row_number"],
                "serial_no": row["serial_no"],
                "name": row["name"],
                "errors": row["errors"],
            } for row in rows if row["errors"]]


def _preview_result(rows: list[dict[str, object]], errors: list[dict[str, object]]) -> dict[str, object]:
    valid_rows = [row for row in rows if not row["errors"]]
    return {
        "total_rows": len(rows),
        "valid_count": len(valid_rows),
        "rejected_count": len(errors),
        "rows": rows,
        "rejected_rows": errors,
    }


@router.get("")
async def list_voters(
    election_id: int = Query(gt=0),
    page: int = Query(default=1, gt=0),
    page_size: int = Query(default=50, ge=1, le=200),
    search: str | None = Query(default=None, max_length=100),
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Return a page of voter records for the selected election."""
    election = await session.get(ElectionRecord, election_id)
    if election is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "ELECTION_NOT_FOUND", "message": "Selected election was not found"},
        )

    filters = [VoterRecord.election_id == election_id]
    normalized_search = search.strip() if search else ""
    if normalized_search:
        pattern = f"%{normalized_search}%"
        filters.append(or_(
            VoterRecord.serial_no.ilike(pattern),
            VoterRecord.name.ilike(pattern),
            VoterRecord.father_husband_name.ilike(pattern),
        ))

    total = await session.scalar(select(func.count()).select_from(VoterRecord).where(*filters)) or 0
    voters = await session.scalars(
        select(VoterRecord)
        .where(*filters)
        .order_by(VoterRecord.serial_no)
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    return {
        "items": [
            {
                "id": voter.id,
                "serial_no": voter.serial_no,
                "name": voter.name,
                "father_husband_name": voter.father_husband_name,
                "photo": voter.photo,
                "thokuthi": voter.thokuthi,
                "age": voter.age,
                "gender": voter.gender,
                "address": voter.address,
                "status": voter.status.value if isinstance(voter.status, VoterStatus) else voter.status,
            }
            for voter in voters
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.post("/import/preview")
async def preview_voter_import(
    election_id: int = Form(gt=0),
    file: UploadFile = File(...),
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Validate a voter CSV and return row-level issues without writing records."""
    await _require_draft_election(election_id, session)
    rows, errors = _parse_csv(await _read_csv(file))
    await _mark_existing_serials(election_id, rows, errors, session)
    return _preview_result(rows, errors)


@router.post("/import", status_code=status.HTTP_201_CREATED)
async def import_voters(
    election_id: int = Form(gt=0),
    file: UploadFile = File(...),
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, object]:
    """Revalidate a previewed CSV and atomically insert its valid voter rows."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": _VOTER_IMPORT_LOCK_ID})
    await _require_draft_election(election_id, session, lock=True)
    rows, errors = _parse_csv(await _read_csv(file))
    await _mark_existing_serials(election_id, rows, errors, session)
    valid_rows = [row for row in rows if not row["errors"]]
    if not valid_rows:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "NO_VALID_VOTERS",
                "message": "No voters were imported because every row has an error",
                "preview": _preview_result(rows, errors),
            },
        )

    voters = [
        VoterRecord(
            election_id=election_id,
            serial_no=row["serial_no"],
            name=row["name"],
            father_husband_name=row["father_husband_name"],
            photo=row["photo"],
            thokuthi=row["thokuthi"],
            age=row["age"],
            gender=row["gender"],
            address=row["address"],
            status=VoterStatus.ELIGIBLE,
        )
        for row in valid_rows
    ]
    session.add_all(voters)
    try:
        await session.flush()
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "VOTER_IMPORT_CONFLICT", "message": "Voter data changed during import. Preview the CSV again and retry."},
        ) from exc

    return {
        "imported_count": len(voters),
        "rejected_count": len(errors),
        "rejected_rows": errors,
    }
