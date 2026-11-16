"""Request schemas for administrator-managed staff accounts."""

import re

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from app.db.models import StaffRole


class StaffCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=3, max_length=64)
    full_name: str = Field(min_length=1, max_length=120)
    password: SecretStr = Field(min_length=12, max_length=128)
    role: StaffRole

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        username = value.strip().lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,63}", username):
            raise ValueError("Use 3 to 64 letters, numbers, dots, underscores, or hyphens")
        return username

    @field_validator("full_name")
    @classmethod
    def normalize_full_name(cls, value: str) -> str:
        full_name = value.strip()
        if not full_name:
            raise ValueError("Full name cannot be blank")
        return full_name

    @field_validator("role", mode="before")
    @classmethod
    def normalize_role(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        role = value.strip().upper().replace(" ", "_").replace("-", "_")
        if role == "GATE1_OFFICER":
            return StaffRole.ENTRY_OFFICER
        return role


class StaffStatusUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    is_active: bool


class StaffUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=3, max_length=64)
    full_name: str = Field(min_length=1, max_length=120)
    password: SecretStr | None = Field(default=None, min_length=12, max_length=128)
    role: StaffRole

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        username = value.strip().lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,63}", username):
            raise ValueError("Use 3 to 64 letters, numbers, dots, underscores, or hyphens")
        return username

    @field_validator("full_name")
    @classmethod
    def normalize_full_name(cls, value: str) -> str:
        full_name = value.strip()
        if not full_name:
            raise ValueError("Full name cannot be blank")
        return full_name

    @field_validator("role", mode="before")
    @classmethod
    def normalize_role(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        role = value.strip().upper().replace(" ", "_").replace("-", "_")
        if role == "GATE1_OFFICER":
            return StaffRole.ENTRY_OFFICER
        return role
