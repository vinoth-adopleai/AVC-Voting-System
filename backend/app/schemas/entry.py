"""Request schemas for entry desk operations."""

from pydantic import BaseModel, ConfigDict, Field


class EntryActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    voter_id: int = Field(gt=0)
