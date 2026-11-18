"""PostgreSQL reporting views and read-only ORM mappings."""

from sqlalchemy import (
    BigInteger,
    CHAR,
    Column,
    DDL,
    DateTime,
    Integer,
    MetaData,
    SmallInteger,
    String,
    Table,
    Text,
    event,
)
from sqlalchemy.orm import registry

from app.db.models import Base

view_registry = registry(metadata=MetaData())

v_voter_choices_table = Table(
    "v_voter_choices",
    view_registry.metadata,
    Column("election_id", SmallInteger, primary_key=True),
    Column("serial_no", String(20), primary_key=True),
    Column("voter_name", Text, nullable=False),
    Column("display_order", SmallInteger, primary_key=True),
    Column("position_name", Text, nullable=False),
    Column("candidate_id", Integer, primary_key=True),
    Column("candidate_ta", Text, nullable=False),
    Column("candidate_en", Text),
    Column("submitted_at", DateTime(timezone=True), primary_key=True),
)

v_candidate_voters_table = Table(
    "v_candidate_voters",
    view_registry.metadata,
    Column("candidate_id", Integer, primary_key=True),
    Column("candidate_ta", Text, nullable=False),
    Column("candidate_en", Text),
    Column("position_name", Text, nullable=False),
    Column("serial_no", String(20), primary_key=True),
    Column("voter_name", Text, nullable=False),
    Column("submitted_at", DateTime(timezone=True), primary_key=True),
)

v_results_table = Table(
    "v_results",
    view_registry.metadata,
    Column("display_order", SmallInteger, nullable=False),
    Column("position_name", Text, nullable=False),
    Column("candidate_id", Integer, primary_key=True),
    Column("candidate_ta", Text, nullable=False),
    Column("candidate_en", Text),
    Column("vote_count", BigInteger, nullable=False),
    Column("ballot_no", SmallInteger, nullable=False),
    Column("election_id", SmallInteger, primary_key=True),
    Column("position_name_ta", Text, nullable=False),
    Column("photo_url", Text),
    Column("position_id", SmallInteger, nullable=False),
)

v_voter_summary_table = Table(
    "v_voter_summary",
    view_registry.metadata,
    Column("election_id", SmallInteger, primary_key=True),
    Column("total_voters", BigInteger, nullable=False),
    Column("entered_voters", BigInteger, nullable=False),
    Column("voted_voters", BigInteger, nullable=False),
    Column("not_entered_voters", BigInteger, nullable=False),
)

v_thokuthi_gender_table = Table(
    "v_thokuthi_gender_counts",
    view_registry.metadata,
    Column("election_id", SmallInteger, primary_key=True),
    Column("thokuthi", String(100), primary_key=True, nullable=False),
    Column("gender", CHAR(1), primary_key=True, nullable=False),
    Column("voter_count", BigInteger, nullable=False),
)


class VoterChoiceView:
    """A voter's submitted choices, exposed by ``v_voter_choices``."""


class CandidateVotersView:
    """Voters who selected a candidate, exposed by ``v_candidate_voters``."""


class ElectionResultsView:
    """Submitted vote totals, exposed by ``v_results``."""


class VoterSummaryView:
    """Status counts for every election, exposed by ``v_voter_summary``."""


class ThokuthiGenderCountView:
    """Voter counts by Thokuthi and gender, exposed by ``v_thokuthi_gender_counts``."""


view_registry.map_imperatively(VoterChoiceView, v_voter_choices_table)
view_registry.map_imperatively(CandidateVotersView, v_candidate_voters_table)
view_registry.map_imperatively(ElectionResultsView, v_results_table)
view_registry.map_imperatively(VoterSummaryView, v_voter_summary_table)
view_registry.map_imperatively(ThokuthiGenderCountView, v_thokuthi_gender_table)


_create_views = (
    """
    CREATE OR REPLACE VIEW v_voter_choices AS
    SELECT v.election_id, v.serial_no, v.name AS voter_name,
           p.display_order, p.name_en AS position_name,
           c.id AS candidate_id, c.name_ta AS candidate_ta, c.name_en AS candidate_en,
           b.submitted_at
    FROM ballots b
    JOIN voters v ON v.id = b.voter_id
    JOIN votes vt ON vt.ballot_id = b.id
    JOIN positions p ON p.id = vt.position_id
    JOIN candidates c ON c.id = vt.candidate_id
    WHERE b.status = 'SUBMITTED'
    """,
    """
    CREATE OR REPLACE VIEW v_candidate_voters AS
    SELECT c.id AS candidate_id, c.name_ta AS candidate_ta, c.name_en AS candidate_en,
           p.name_en AS position_name,
           v.serial_no, v.name AS voter_name, b.submitted_at
    FROM votes vt
    JOIN ballots b ON b.id = vt.ballot_id
    JOIN voters v ON v.id = b.voter_id
    JOIN candidates c ON c.id = vt.candidate_id
    JOIN positions p ON p.id = vt.position_id
    WHERE b.status = 'SUBMITTED'
    """,
    """
    CREATE OR REPLACE VIEW v_results AS
    SELECT p.display_order, p.name_en AS position_name,
           c.id AS candidate_id, c.name_ta AS candidate_ta, c.name_en AS candidate_en,
           COUNT(x.vote_id) AS vote_count, c.ballot_no, p.election_id,
           p.name_ta AS position_name_ta, c.photo_url, p.id AS position_id
    FROM candidates c
    JOIN positions p ON p.id = c.position_id
    LEFT JOIN (
        SELECT vt.id AS vote_id, vt.candidate_id
        FROM votes vt
        JOIN ballots b ON b.id = vt.ballot_id
        WHERE b.status = 'SUBMITTED'
    ) x ON x.candidate_id = c.id
    GROUP BY p.display_order, p.name_en, c.id, c.name_ta, c.name_en,
             c.ballot_no, p.election_id, p.name_ta, c.photo_url, p.id
    """,
)

DASHBOARD_VIEW_DDL = (
    """
    CREATE OR REPLACE VIEW v_voter_summary AS
    SELECT e.id AS election_id,
           COUNT(v.id) AS total_voters,
           COUNT(v.id) FILTER (WHERE v.status IN ('ENTERED', 'BOOTH_ASSIGNED')) AS entered_voters,
           COUNT(v.id) FILTER (WHERE v.status = 'VOTED') AS voted_voters,
           COUNT(v.id) FILTER (WHERE v.status = 'ELIGIBLE') AS not_entered_voters
    FROM elections e
    LEFT JOIN voters v ON v.election_id = e.id
    GROUP BY e.id
    """,
    """
    CREATE OR REPLACE VIEW v_thokuthi_gender_counts AS
    SELECT v.election_id,
           COALESCE(v.thokuthi, '') AS thokuthi,
           COALESCE(v.gender::text, '') AS gender,
           COUNT(*) AS voter_count
    FROM voters v
    GROUP BY v.election_id, COALESCE(v.thokuthi, ''), COALESCE(v.gender::text, '')
    """,
)

_drop_views = (
    "DROP VIEW IF EXISTS v_thokuthi_gender_counts",
    "DROP VIEW IF EXISTS v_voter_summary",
    "DROP VIEW IF EXISTS v_results",
    "DROP VIEW IF EXISTS v_candidate_voters",
    "DROP VIEW IF EXISTS v_voter_choices",
)

for _statement in _create_views:
    event.listen(
        Base.metadata,
        "after_create",
        DDL(_statement).execute_if(dialect="postgresql"),
    )

for _statement in _drop_views:
    event.listen(
        Base.metadata,
        "before_drop",
        DDL(_statement).execute_if(dialect="postgresql"),
    )
