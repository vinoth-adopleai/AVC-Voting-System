"""Local storage paths for uploaded election media."""

from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
MEDIA_ROOT = BACKEND_DIR / "media"
CANDIDATE_PHOTO_DIR = MEDIA_ROOT / "candidates"


def ensure_media_directories() -> None:
    MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
    CANDIDATE_PHOTO_DIR.mkdir(parents=True, exist_ok=True)
