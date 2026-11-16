"""Administrator request schemas for booths and voting systems."""

from pydantic import BaseModel, ConfigDict, Field


class MonitorDeskBulkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    election_id: int = Field(gt=0)
    count: int = Field(ge=1, le=150)


class MonitorDeskAssignment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    officer_id: int | None = Field(default=None, gt=0)
    supervisor_id: int | None = Field(default=None, gt=0)


class VotingSystemBulkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    election_id: int = Field(gt=0)
    monitor_desk_id: int = Field(gt=0)
    count: int = Field(ge=1, le=50)


class VotingSystemTokenExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    election_id: int = Field(gt=0)


class VotingSystemStatusUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    is_active: bool


class BoothAssignmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    voter_id: int = Field(gt=0)
    system_id: int = Field(gt=0)
