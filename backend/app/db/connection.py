"""Async SQLAlchemy engine and session dependency."""

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.settings import settings


engine = create_async_engine(
    settings.db_path,
    pool_pre_ping=True,
    hide_parameters=True,
)
SessionFactory = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


async def get_db_session() -> AsyncIterator[AsyncSession]:
    """Yield a request-scoped database session and close it after the request."""
    async with SessionFactory() as session:
        yield session
