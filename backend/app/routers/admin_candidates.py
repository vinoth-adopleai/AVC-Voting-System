"""Administrator candidate setup endpoints."""

from io import BytesIO
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.auth_dependencies import require_admin
from app.db.connection import get_db_session
from app.db.models import AuditLogRecord, CandidateRecord, ElectionRecord, PositionRecord, StaffUserRecord
from app.schemas.admin import CandidateResponse, CandidateStatusUpdate
from app.storage import CANDIDATE_PHOTO_DIR, ensure_media_directories


router = APIRouter(prefix="/admin", tags=["admin candidates"])
_CANDIDATE_SETUP_LOCK_ID = 741_628_451_035
_MAX_PHOTO_BYTES = 5 * 1024 * 1024
_MAX_PHOTO_PIXELS = 20_000_000
_ALLOWED_IMAGE_FORMATS = {"JPEG", "PNG", "WEBP"}


def _resize_candidate_photo(data: bytes) -> bytes:
    """Validate an uploaded raster image and encode a resized WebP copy."""
    try:
        with Image.open(BytesIO(data)) as source:
            if source.format not in _ALLOWED_IMAGE_FORMATS:
                raise ValueError("Use a JPEG, PNG, or WebP image")
            if source.width * source.height > _MAX_PHOTO_PIXELS:
                raise ValueError("Image dimensions are too large")
            source.verify()

        with Image.open(BytesIO(data)) as source:
            image = ImageOps.exif_transpose(source)
            image.thumbnail((800, 800), Image.Resampling.LANCZOS)
            if image.mode in ("RGBA", "LA") or "transparency" in image.info:
                rgba = image.convert("RGBA")
                background = Image.new("RGB", rgba.size, "white")
                background.paste(rgba, mask=rgba.getchannel("A"))
                image = background
            else:
                image = image.convert("RGB")

            output = BytesIO()
            image.save(output, format="WEBP", quality=85, method=6)
            return output.getvalue()
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError) as exc:
        raise ValueError("The uploaded file is not a valid image") from exc


@router.get("/candidates", response_model=list[CandidateResponse])
async def list_candidates(
    position_id: int = Query(gt=0),
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> list[CandidateRecord]:
    """List candidates for one position in ballot-number order."""
    candidates = await session.scalars(
        select(CandidateRecord)
        .where(CandidateRecord.position_id == position_id)
        .order_by(CandidateRecord.ballot_no)
    )
    return list(candidates)


@router.post(
    "/candidates",
    response_model=CandidateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_candidate(
    position_id: int = Form(gt=0),
    name_ta: str = Form(min_length=1, max_length=120),
    name_en: str = Form(min_length=1, max_length=120),
    photo: UploadFile = File(...),
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> CandidateRecord:
    """Add a candidate with both names and a resized profile photo."""
    normalized_ta = name_ta.strip()
    normalized_en = name_en.strip()
    if not normalized_ta or not normalized_en:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_CANDIDATE_NAME", "message": "Candidate names cannot be blank"},
        )

    if not photo.filename:
        await photo.close()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "CANDIDATE_PHOTO_REQUIRED", "message": "A candidate photo is required"},
        )
    photo_bytes = await photo.read(_MAX_PHOTO_BYTES + 1)
    if len(photo_bytes) > _MAX_PHOTO_BYTES:
        await photo.close()
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={"code": "PHOTO_TOO_LARGE", "message": "Candidate photos must be 5 MB or smaller"},
        )
    try:
        resized_photo = await run_in_threadpool(_resize_candidate_photo, photo_bytes)
    except ValueError as exc:
        await photo.close()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_CANDIDATE_PHOTO", "message": str(exc)},
        ) from exc
    await photo.close()

    await session.execute(
        text("SELECT pg_advisory_xact_lock(:lock_id)"),
        {"lock_id": _CANDIDATE_SETUP_LOCK_ID},
    )
    position = await session.get(PositionRecord, position_id, with_for_update=True)
    if position is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "POSITION_NOT_FOUND", "message": "Position not found"},
        )
    election = await session.get(ElectionRecord, position.election_id, with_for_update=True)
    if election is None or election.status != "DRAFT":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "ELECTION_CONFIGURATION_LOCKED",
                "message": "Candidates can only be added while the election is a draft",
            },
        )

    last_ballot_no = await session.scalar(
        select(func.max(CandidateRecord.ballot_no)).where(
            CandidateRecord.position_id == position.id
        )
    )
    ballot_no = (last_ballot_no or 0) + 1
    if ballot_no > 32_767:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "BALLOT_NUMBER_LIMIT_REACHED", "message": "No more candidates can be added to this position"},
        )

    ensure_media_directories()
    photo_filename = f"{uuid4().hex}.webp"
    photo_url = f"/api/media/candidates/{photo_filename}"
    candidate = CandidateRecord(
        position_id=position.id,
        ballot_no=ballot_no,
        name_ta=normalized_ta,
        name_en=normalized_en,
        photo_url=photo_url,
        is_active=True,
    )
    saved_photo_path = CANDIDATE_PHOTO_DIR / photo_filename
    session.add(candidate)
    try:
        await session.flush()
        if saved_photo_path is not None and resized_photo is not None:
            await run_in_threadpool(saved_photo_path.write_bytes, resized_photo)
        await session.refresh(candidate)
        await session.commit()
    except Exception:
        await session.rollback()
        if saved_photo_path is not None:
            await run_in_threadpool(saved_photo_path.unlink, missing_ok=True)
        raise
    return candidate


@router.patch("/candidates/{candidate_id}/status", response_model=CandidateResponse)
async def update_candidate_status(
    candidate_id: int,
    payload: CandidateStatusUpdate,
    _: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> CandidateRecord:
    """Activate or withdraw a candidate while the election is still a draft."""
    candidate = await session.get(CandidateRecord, candidate_id, with_for_update=True)
    if candidate is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "CANDIDATE_NOT_FOUND", "message": "Candidate not found"},
        )
    position = await session.get(PositionRecord, candidate.position_id)
    election = await session.get(ElectionRecord, position.election_id) if position else None
    if election is None or election.status != "DRAFT":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "ELECTION_CONFIGURATION_LOCKED",
                "message": "Candidate status cannot be changed after the election opens",
            },
        )
    candidate.is_active = payload.is_active
    await session.commit()
    return candidate


@router.put("/candidates/{candidate_id}", response_model=CandidateResponse)
async def update_candidate(
    candidate_id: int,
    position_id: int = Form(gt=0),
    name_ta: str = Form(min_length=1, max_length=120),
    name_en: str | None = Form(default=None, max_length=120),
    photo: UploadFile | None = File(default=None),
    remove_photo: bool = Form(default=False),
    admin: StaffUserRecord = Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
) -> CandidateRecord:
    """Update candidate details and optionally move the candidate within the election."""
    normalized_ta = name_ta.strip()
    normalized_en = name_en.strip() if name_en else None
    if not normalized_ta or (name_en is not None and not normalized_en):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_CANDIDATE_NAME", "message": "Candidate names cannot be blank"},
        )
    if remove_photo and photo is not None and photo.filename:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "CONFLICTING_PHOTO_ACTIONS", "message": "Choose a photo or remove the current photo"},
        )

    resized_photo: bytes | None = None
    if photo is not None:
        if photo.filename:
            photo_bytes = await photo.read(_MAX_PHOTO_BYTES + 1)
            if len(photo_bytes) > _MAX_PHOTO_BYTES:
                await photo.close()
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail={"code": "PHOTO_TOO_LARGE", "message": "Candidate photos must be 5 MB or smaller"},
                )
            try:
                resized_photo = await run_in_threadpool(_resize_candidate_photo, photo_bytes)
            except ValueError as exc:
                await photo.close()
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail={"code": "INVALID_CANDIDATE_PHOTO", "message": str(exc)},
                ) from exc
        await photo.close()

    await session.execute(
        text("SELECT pg_advisory_xact_lock(:lock_id)"),
        {"lock_id": _CANDIDATE_SETUP_LOCK_ID},
    )
    candidate = await session.get(CandidateRecord, candidate_id, with_for_update=True)
    if candidate is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "CANDIDATE_NOT_FOUND", "message": "Candidate not found"},
        )
    previous_position = await session.get(PositionRecord, candidate.position_id, with_for_update=True)
    target_position = await session.get(PositionRecord, position_id, with_for_update=True)
    if target_position is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "POSITION_NOT_FOUND", "message": "Position not found"},
        )
    election_id = previous_position.election_id if previous_position else None
    if previous_position is None or target_position.election_id != election_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "POSITION_ELECTION_MISMATCH",
                "message": "A candidate can only be moved to another position in the same election",
            },
        )
    election = await session.get(ElectionRecord, election_id, with_for_update=True)
    if election is None or election.status != "DRAFT":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "ELECTION_CONFIGURATION_LOCKED",
                "message": "Candidates can only be changed while the election is a draft",
            },
        )

    previous_values = {
        "position_id": candidate.position_id,
        "ballot_no": candidate.ballot_no,
        "name_ta": candidate.name_ta,
        "name_en": candidate.name_en,
        "photo_url": candidate.photo_url,
    }
    old_photo_path = None
    if candidate.photo_url and candidate.photo_url.startswith("/api/media/candidates/"):
        old_photo_name = candidate.photo_url.rsplit("/", 1)[-1]
        if old_photo_name and Path(old_photo_name).name == old_photo_name:
            old_photo_path = CANDIDATE_PHOTO_DIR / old_photo_name

    new_ballot_no = candidate.ballot_no
    if target_position.id != candidate.position_id:
        last_ballot_no = await session.scalar(
            select(func.max(CandidateRecord.ballot_no)).where(
                CandidateRecord.position_id == target_position.id
            )
        )
        new_ballot_no = (last_ballot_no or 0) + 1
        if new_ballot_no > 32_767:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "BALLOT_NUMBER_LIMIT_REACHED",
                    "message": "No more candidates can be added to this position",
                },
            )

    new_photo_filename = f"{uuid4().hex}.webp" if resized_photo else None
    new_photo_path = CANDIDATE_PHOTO_DIR / new_photo_filename if new_photo_filename else None
    candidate.position_id = target_position.id
    candidate.ballot_no = new_ballot_no
    candidate.name_ta = normalized_ta
    candidate.name_en = normalized_en
    if new_photo_filename:
        candidate.photo_url = f"/api/media/candidates/{new_photo_filename}"
    elif remove_photo:
        candidate.photo_url = None

    session.add(AuditLogRecord(
        actor_id=admin.id,
        action="CANDIDATE_UPDATED",
        entity="candidates",
        entity_id=str(candidate.id),
        details={
            "election_id": election.id,
            "position_id": target_position.id,
            "previous_position_id": previous_position.id,
            "previous": previous_values,
            "updated": {
                "position_id": candidate.position_id,
                "ballot_no": candidate.ballot_no,
                "name_ta": candidate.name_ta,
                "name_en": candidate.name_en,
                "photo_url": candidate.photo_url,
            },
        },
    ))
    ensure_media_directories()
    try:
        if new_photo_path is not None and resized_photo is not None:
            await run_in_threadpool(new_photo_path.write_bytes, resized_photo)
        await session.commit()
        await session.refresh(candidate)
    except Exception:
        await session.rollback()
        if new_photo_path is not None:
            await run_in_threadpool(new_photo_path.unlink, missing_ok=True)
        raise
    if old_photo_path is not None and old_photo_path != new_photo_path and (new_photo_path or remove_photo):
        await run_in_threadpool(old_photo_path.unlink, missing_ok=True)
    return candidate
