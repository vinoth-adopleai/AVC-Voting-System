"""Administrator election setup schemas."""

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ElectionSetupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    election_id: int | None = Field(default=None, gt=0)
    name: str = Field(min_length=1, max_length=200)
    election_date: date

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        name = value.strip()
        if not name:
            raise ValueError("Election name cannot be empty")
        return name

class ElectionOpenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirm_servers_healthy: bool = False
    election_id: int | None = Field(default=None, gt=0)


class ElectionCloseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    election_id: int | None = Field(default=None, gt=0)


class ElectionSetupResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    election_date: date
    start_time: datetime | None
    end_time: datetime | None
    ballot_total: int
    status: str


class ElectionOptionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    status: str
    election_date: date
    start_time: datetime | None
    end_time: datetime | None


class PositionCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    election_id: int = Field(gt=0)
    name_en: str = Field(min_length=1, max_length=120)
    name_ta: str = Field(min_length=1, max_length=120)
    min_choices: int = Field(ge=1, le=5)
    max_choices: int = Field(ge=1, le=5)

    @field_validator("name_en", "name_ta")
    @classmethod
    def normalize_position_name(cls, value: str) -> str:
        name = value.strip()
        if not name:
            raise ValueError("Position names cannot be empty")
        return name

    @model_validator(mode="after")
    def validate_choice_range(self):
        if self.min_choices > self.max_choices:
            raise ValueError("min_choices cannot be greater than max_choices")
        return self


class PositionUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name_en: str = Field(min_length=1, max_length=120)
    name_ta: str = Field(min_length=1, max_length=120)
    min_choices: int = Field(ge=1, le=5)
    max_choices: int = Field(ge=1, le=5)

    @field_validator("name_en", "name_ta")
    @classmethod
    def normalize_position_name(cls, value: str) -> str:
        name = value.strip()
        if not name:
            raise ValueError("Position names cannot be empty")
        return name

    @model_validator(mode="after")
    def validate_choice_range(self):
        if self.min_choices > self.max_choices:
            raise ValueError("min_choices cannot be greater than max_choices")
        return self


class PositionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    name_en: str
    name_ta: str
    min_choices: int
    max_choices: int
    display_order: int


class PositionListResponse(BaseModel):
    election_id: int | None
    election_name: str | None
    election_status: str | None
    positions: list[PositionResponse]


class CandidateResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    position_id: int
    ballot_no: int
    name_ta: str
    name_en: str | None
    photo_url: str | None
    is_active: bool


class CandidateStatusUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    is_active: bool

