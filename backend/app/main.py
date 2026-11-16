"""FastAPI application entry point."""

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.connection import engine, get_db_session
from app.db.initialize import initialize_database
from app.routers.auth import router as auth_router
from app.routers.admin import router as admin_router
from app.routers.admin_candidates import router as admin_candidates_router
from app.routers.admin_voters import router as admin_voters_router
from app.routers.admin_staff import router as admin_staff_router
from app.routers.admin_systems import router as admin_systems_router
from app.routers.entry import router as entry_router
from app.routers.monitor import router as monitor_router
from app.routers.booth import router as booth_router
from app.storage import MEDIA_ROOT, ensure_media_directories


logger = logging.getLogger(__name__)
ensure_media_directories()


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Initialize the schema before serving requests and close the pool on shutdown."""
    await initialize_database()
    yield
    await engine.dispose()


app = FastAPI(
    title="AVC Election Voting API",
    version="1.0.0",
    lifespan=lifespan,
)
app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(admin_candidates_router)
app.include_router(admin_voters_router)
app.include_router(admin_staff_router)
app.include_router(admin_systems_router)
app.include_router(entry_router)
app.include_router(monitor_router)
app.include_router(booth_router)
app.mount("/media", StaticFiles(directory=MEDIA_ROOT), name="media")


@app.get("/healthz", response_model=dict[str, str], status_code=status.HTTP_200_OK)
async def health_check(
    session: AsyncSession = Depends(get_db_session),
) -> dict[str, str]:
    """Check that the API can reach its configured database."""
    try:
        await session.execute(text("SELECT 1"))
    except Exception as exc:
        logger.exception("Database health check failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "DATABASE_UNAVAILABLE", "message": "Database unavailable"},
        ) from exc
    return {"status": "healthy", "database": "connected"}
