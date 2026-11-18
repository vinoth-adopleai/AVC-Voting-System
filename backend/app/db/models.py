"""SQLAlchemy models and PostgreSQL enum types for election operations."""

from datetime import date, datetime
from enum import Enum
from uuid import UUID, uuid4

from sqlalchemy import (
    BigInteger,
    Boolean,
    CHAR,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Identity,
    Integer,
    PrimaryKeyConstraint,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ENUM, INET, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """Base metadata for database tables and PostgreSQL enum types."""


class VoterStatus(str, Enum):
    ELIGIBLE = "ELIGIBLE"
    ENTERED = "ENTERED"
    BOOTH_ASSIGNED = "BOOTH_ASSIGNED"
    VOTED = "VOTED"


class SystemStatus(str, Enum):
    FREE = "FREE"
    OCCUPIED = "OCCUPIED"
    OFFLINE = "OFFLINE"


class StaffRole(str, Enum):
    ADMIN = "ADMIN"
    ENTRY_OFFICER = "ENTRY_OFFICER"
    MONITOR_OFFICER = "MONITOR_OFFICER"
    MONITOR_SUPERVISOR = "MONITOR_SUPERVISOR"
    AUDITOR = "AUDITOR"


def _enum_labels(enum_class: type[Enum]) -> list[str]:
    return [member.value for member in enum_class]


voter_status_type = ENUM(
    VoterStatus,
    name="voter_status",
    values_callable=_enum_labels,
    create_type=True,
)
system_status_type = ENUM(
    SystemStatus,
    name="system_status",
    values_callable=_enum_labels,
    create_type=True,
)
staff_role_type = ENUM(
    StaffRole,
    name="staff_role",
    values_callable=_enum_labels,
    create_type=True,
)


class ElectionRecord(Base):
    __tablename__ = "elections"
    __table_args__ = (
        CheckConstraint("ballot_total > 0", name="ck_elections_ballot_total_positive"),
        CheckConstraint(
            "start_time IS NULL OR end_time IS NULL OR end_time > start_time",
            name="ck_elections_time_range",
        ),
        CheckConstraint(
            "status IN ('DRAFT', 'OPEN', 'CLOSED', 'PUBLISHED')",
            name="ck_elections_status",
        ),
    )

    id: Mapped[int] = mapped_column(SmallInteger, Identity(always=True), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    election_date: Mapped[date] = mapped_column(Date, nullable=False)
    start_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    end_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ballot_total: Mapped[int] = mapped_column(
        SmallInteger,
        nullable=False,
        default=23,
        server_default=text("23"),
    )
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="DRAFT",
        server_default=text("'DRAFT'"),
    )


class PositionRecord(Base):
    __tablename__ = "positions"
    __table_args__ = (
        UniqueConstraint("election_id", "code", name="uq_positions_election_code"),
        UniqueConstraint(
            "election_id",
            "display_order",
            name="uq_positions_election_display_order",
        ),
        CheckConstraint(
            "min_choices >= 1 AND min_choices <= max_choices",
            name="ck_positions_choice_range",
        ),
    )

    id: Mapped[int] = mapped_column(SmallInteger, Identity(always=True), primary_key=True)
    election_id: Mapped[int] = mapped_column(
        SmallInteger,
        ForeignKey("elections.id"),
        nullable=False,
    )
    code: Mapped[str] = mapped_column(Text, nullable=False)
    name_ta: Mapped[str] = mapped_column(Text, nullable=False)
    name_en: Mapped[str] = mapped_column(Text, nullable=False)
    min_choices: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    max_choices: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    display_order: Mapped[int] = mapped_column(SmallInteger, nullable=False)


class CandidateRecord(Base):
    __tablename__ = "candidates"
    __table_args__ = (
        UniqueConstraint("position_id", "ballot_no", name="uq_candidates_position_ballot_no"),
        UniqueConstraint("id", "position_id", name="uq_candidates_id_position_id"),
    )

    id: Mapped[int] = mapped_column(Integer, Identity(always=True), primary_key=True)
    position_id: Mapped[int] = mapped_column(
        SmallInteger,
        ForeignKey("positions.id"),
        nullable=False,
    )
    ballot_no: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    name_ta: Mapped[str] = mapped_column(Text, nullable=False)
    name_en: Mapped[str | None] = mapped_column(Text, nullable=True)
    photo_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
        server_default=text("TRUE"),
    )


class StaffUserRecord(Base):
    __tablename__ = "staff_users"

    id: Mapped[int] = mapped_column(Integer, Identity(always=True), primary_key=True)
    username: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    full_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[StaffRole] = mapped_column(staff_role_type, nullable=False)
    totp_secret_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    failed_logins: Mapped[int] = mapped_column(
        SmallInteger,
        nullable=False,
        default=0,
        server_default=text("0"),
    )
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
        server_default=text("TRUE"),
    )


class StaffAuthSessionRecord(Base):
    """Hashed refresh-token sessions for staff authentication."""

    __tablename__ = "staff_auth_sessions"
    __table_args__ = (
        Index("ix_staff_auth_sessions_user", "staff_user_id"),
        Index("ix_staff_auth_sessions_expiry", "expires_at"),
    )

    refresh_token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    staff_user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("staff_users.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class VoterRecord(Base):
    __tablename__ = "voters"
    __table_args__ = (
        UniqueConstraint("election_id", "serial_no", name="uq_voters_election_serial_no"),
        CheckConstraint("age >= 18", name="ck_voters_minimum_age"),
        CheckConstraint(
            "status = 'ELIGIBLE' OR (entered_at IS NOT NULL AND entry_allowed_by IS NOT NULL)",
            name="ck_voters_entry_details_for_noneligible",
        ),
        CheckConstraint(
            "status NOT IN ('BOOTH_ASSIGNED', 'VOTED') OR vote_allowed_by IS NOT NULL",
            name="ck_voters_vote_authorization",
        ),
        CheckConstraint("status <> 'VOTED' OR voted_at IS NOT NULL", name="ck_voters_voted_at"),
    )

    id: Mapped[int] = mapped_column(Integer, Identity(always=True), primary_key=True)
    election_id: Mapped[int] = mapped_column(
        SmallInteger,
        ForeignKey("elections.id"),
        nullable=False,
    )
    serial_no: Mapped[str] = mapped_column(String(20), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    father_husband_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    photo: Mapped[str | None] = mapped_column(Text, nullable=True)
    thokuthi: Mapped[str | None] = mapped_column(String(100), nullable=True)
    age: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    gender: Mapped[str | None] = mapped_column(CHAR(1), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[VoterStatus] = mapped_column(
        voter_status_type,
        nullable=False,
        default=VoterStatus.ELIGIBLE,
        server_default=text("'ELIGIBLE'"),
    )
    entered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    entry_allowed_by: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("staff_users.id"),
        nullable=True,
    )
    vote_allowed_by: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("staff_users.id"),
        nullable=True,
    )
    voted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class MonitorDeskRecord(Base):
    __tablename__ = "monitor_desks"
    __table_args__ = (
        UniqueConstraint("election_id", "desk_no", name="uq_monitor_desks_election_desk"),
    )

    id: Mapped[int] = mapped_column(SmallInteger, Identity(always=True), primary_key=True)
    election_id: Mapped[int] = mapped_column(
        SmallInteger,
        ForeignKey("elections.id"),
        nullable=False,
    )
    desk_no: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    officer_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("staff_users.id"),
        nullable=True,
    )
    supervisor_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("staff_users.id"),
        nullable=True,
    )


class VotingSystemRecord(Base):
    __tablename__ = "voting_systems"
    __table_args__ = (
        UniqueConstraint("election_id", "system_no", name="uq_voting_systems_election_system"),
        UniqueConstraint("token_hash", name="uq_voting_systems_token_hash"),
        UniqueConstraint("current_voter_id", name="uq_voting_systems_current_voter"),
        CheckConstraint(
            "(status = 'OCCUPIED') = (current_voter_id IS NOT NULL)",
            name="ck_voting_systems_occupied_voter",
        ),
    )

    id: Mapped[int] = mapped_column(SmallInteger, Identity(always=True), primary_key=True)
    election_id: Mapped[int] = mapped_column(
        SmallInteger,
        ForeignKey("elections.id"),
        nullable=False,
    )
    monitor_desk_id: Mapped[int] = mapped_column(
        SmallInteger,
        ForeignKey("monitor_desks.id"),
        nullable=False,
    )
    system_no: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    name: Mapped[str | None] = mapped_column(Text, nullable=True)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[SystemStatus] = mapped_column(
        system_status_type,
        nullable=False,
        default=SystemStatus.FREE,
        server_default=text("'FREE'"),
    )
    current_voter_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("voters.id"),
        nullable=True,
    )
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
        server_default=text("TRUE"),
    )


class BallotRecord(Base):
    __tablename__ = "ballots"
    __table_args__ = (
        CheckConstraint(
            "status IN ('SUBMITTED', 'VOID')",
            name="ck_ballots_status",
        ),
        Index(
            "ux_one_ballot_per_voter",
            "voter_id",
            unique=True,
            postgresql_where=text("status = 'SUBMITTED'"),
        ),
        Index("ix_ballots_election", "election_id", "submitted_at"),
        Index("ix_ballots_voter", "voter_id"),
        Index("ix_ballots_system", "system_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    election_id: Mapped[int] = mapped_column(
        SmallInteger,
        ForeignKey("elections.id"),
        nullable=False,
    )
    voter_id: Mapped[int] = mapped_column(Integer, ForeignKey("voters.id"), nullable=False)
    system_id: Mapped[int] = mapped_column(
        SmallInteger,
        ForeignKey("voting_systems.id"),
        nullable=False,
    )
    authorized_by: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("staff_users.id"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="SUBMITTED",
        server_default=text("'SUBMITTED'"),
    )
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class VoteRecord(Base):
    __tablename__ = "votes"
    __table_args__ = (
        ForeignKeyConstraint(
            ["candidate_id", "position_id"],
            ["candidates.id", "candidates.position_id"],
            name="fk_votes_candidate_position",
        ),
        UniqueConstraint("ballot_id", "candidate_id", name="uq_votes_ballot_candidate"),
        Index("ix_votes_ballot", "ballot_id"),
        Index("ix_votes_candidate", "candidate_id"),
        Index("ix_votes_position", "position_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    ballot_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("ballots.id"), nullable=False)
    position_id: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    candidate_id: Mapped[int] = mapped_column(Integer, nullable=False)


class IdempotencyKeyRecord(Base):
    __tablename__ = "idempotency_keys"
    __table_args__ = (
        PrimaryKeyConstraint("endpoint", "key", name="pk_idempotency_keys"),
        Index("ix_idem_created", "created_at"),
    )

    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    key: Mapped[str] = mapped_column(Text, nullable=False)
    system_id: Mapped[int | None] = mapped_column(
        SmallInteger,
        ForeignKey("voting_systems.id"),
        nullable=True,
    )
    staff_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("staff_users.id"),
        nullable=True,
    )
    status_code: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    response: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class ExceptionEventRecord(Base):
    __tablename__ = "exception_events"
    __table_args__ = (
        CheckConstraint(
            "event_type IN ('SYSTEM_RESET', 'ENTRY_UNDO', 'VOTER_REASSIGN', "
            "'SYSTEM_FAULT', 'MANUAL_CORRECTION', 'BALLOT_VOID')",
            name="ck_exception_events_type",
        ),
        Index("ix_exceptions_voter", "voter_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    election_id: Mapped[int] = mapped_column(
        SmallInteger,
        ForeignKey("elections.id"),
        nullable=False,
    )
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    voter_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("voters.id"),
        nullable=True,
    )
    system_id: Mapped[int | None] = mapped_column(
        SmallInteger,
        ForeignKey("voting_systems.id"),
        nullable=True,
    )
    actor_id: Mapped[int] = mapped_column(Integer, ForeignKey("staff_users.id"), nullable=False)
    approved_by: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("staff_users.id"),
        nullable=True,
    )
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class AuditLogRecord(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_created", "created_at"),
        Index("ix_audit_actor", "actor_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    actor_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("staff_users.id"),
        nullable=True,
    )
    system_id: Mapped[int | None] = mapped_column(
        SmallInteger,
        ForeignKey("voting_systems.id"),
        nullable=True,
    )
    action: Mapped[str] = mapped_column(Text, nullable=False)
    entity: Mapped[str | None] = mapped_column(Text, nullable=True)
    entity_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    details: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    ip: Mapped[str | None] = mapped_column(INET, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class VoteLookupRecord(Base):
    __tablename__ = "vote_lookups"
    __table_args__ = (
        CheckConstraint(
            "lookup_type IN ('BY_VOTER', 'BY_CANDIDATE')",
            name="ck_vote_lookups_type",
        ),
        CheckConstraint(
            "(lookup_type = 'BY_VOTER' AND voter_id IS NOT NULL) OR "
            "(lookup_type = 'BY_CANDIDATE' AND candidate_id IS NOT NULL)",
            name="ck_vote_lookups_target",
        ),
        Index("ix_lookups_actor", "actor_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    actor_id: Mapped[int] = mapped_column(Integer, ForeignKey("staff_users.id"), nullable=False)
    lookup_type: Mapped[str] = mapped_column(Text, nullable=False)
    voter_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("voters.id"),
        nullable=True,
    )
    candidate_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("candidates.id"),
        nullable=True,
    )
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    approved_by: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("staff_users.id"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class ReportExportRecord(Base):
    __tablename__ = "report_exports"
    __table_args__ = (
        CheckConstraint(
            "status IN ('QUEUED', 'RUNNING', 'READY', 'FAILED')",
            name="ck_report_exports_status",
        ),
        CheckConstraint(
            "report_type IN ('TURNOUT', 'FINAL_RESULTS', 'RECONCILIATION')",
            name="ck_report_exports_type",
        ),
        CheckConstraint(
            "export_format IN ('PDF', 'XLSX')",
            name="ck_report_exports_format",
        ),
        Index("ix_report_exports_queue", "status", "created_at"),
        Index("ix_report_exports_actor", "requested_by", "created_at"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    election_id: Mapped[int] = mapped_column(
        SmallInteger,
        ForeignKey("elections.id"),
        nullable=False,
    )
    requested_by: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("staff_users.id"),
        nullable=False,
    )
    report_type: Mapped[str] = mapped_column(Text, nullable=False)
    export_format: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="QUEUED",
        server_default=text("'QUEUED'"),
    )
    file_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


Index(
    "ix_voters_name_trgm",
    text("lower(name) gin_trgm_ops"),
    postgresql_using="gin",
)
Index("ix_voters_status", VoterRecord.election_id, VoterRecord.status)
Index("ix_positions_election", PositionRecord.election_id)
Index(
    "ix_candidates_pos",
    CandidateRecord.position_id,
    postgresql_where=text("is_active"),
)
Index("ix_monitor_desks_officer", MonitorDeskRecord.officer_id)
Index("ix_voting_systems_desk", VotingSystemRecord.monitor_desk_id)
Index("ix_voting_systems_status", VotingSystemRecord.election_id, VotingSystemRecord.status)


