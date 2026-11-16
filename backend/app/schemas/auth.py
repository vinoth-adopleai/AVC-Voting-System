"""Authentication request and response schemas."""

import re

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from app.db.models import StaffRole


class BootstrapAdminRequest(BaseModel):
    """Input for the one-time first administrator setup endpoint."""

    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=3, max_length=64)
    full_name: str = Field(min_length=1, max_length=120)
    password: SecretStr = Field(min_length=12, max_length=128)

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        username = value.strip().lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,63}", username):
            raise ValueError(
                "Username must be 3 to 64 characters and use letters, numbers, dots, underscores, or hyphens"
            )
        return username

    @field_validator("full_name")
    @classmethod
    def normalize_full_name(cls, value: str) -> str:
        full_name = value.strip()
        if not full_name:
            raise ValueError("Full name cannot be empty")
        return full_name


class BootstrapAdminResponse(BaseModel):
    """Public account fields returned after administrator creation."""

    id: int
    username: str
    display_name: str
    role: StaffRole
    is_active: bool


class LoginRequest(BaseModel):
    """Username and password submitted by the staff sign-in form."""

    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=3, max_length=64)
    password: SecretStr = Field(min_length=1, max_length=128)

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        username = value.strip().lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,63}", username):
            raise ValueError("Invalid username")
        return username


class AuthenticatedUser(BaseModel):
    id: int
    username: str
    display_name: str
    role: StaffRole


class AuthSessionResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: AuthenticatedUser
