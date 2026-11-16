"""Application settings loaded from the backend .env file and environment."""

from pathlib import Path

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    """Runtime configuration for the FastAPI application."""

    db_path: str = Field(validation_alias="DB_PATH")
    admin_bootstrap_token: SecretStr = Field(
        default=SecretStr(""),
        validation_alias="ADMIN_BOOTSTRAP_TOKEN",
    )
    access_token_secret: SecretStr = Field(
        default=SecretStr(""),
        validation_alias="ACCESS_TOKEN_SECRET",
    )
    device_token_secret: SecretStr = Field(
        default=SecretStr(""),
        validation_alias="DEVICE_TOKEN_SECRET",
    )
    auth_cookie_secure: bool = Field(
        default=False,
        validation_alias="AUTH_COOKIE_SECURE",
    )

    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @field_validator("db_path", mode="before")
    @classmethod
    def normalize_db_path(cls, value: str) -> str:
        """Accept a SQLAlchemy URL, including a nested DATABASE_URL assignment."""
        if not isinstance(value, str):
            raise ValueError("DB_PATH must be a database URL")

        url = value.strip().strip('"').strip("'")
        if url.startswith("DATABASE_URL="):
            url = url.removeprefix("DATABASE_URL=").strip()

        if url.startswith("postgresql+psycopg2://"):
            url = url.replace(
                "postgresql+psycopg2://", "postgresql+asyncpg://", 1
            )
        elif url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+asyncpg://", 1)

        if not url.startswith("postgresql+asyncpg://"):
            raise ValueError(
                "DB_PATH must use PostgreSQL with the asyncpg SQLAlchemy driver"
            )
        return url


settings = Settings()
