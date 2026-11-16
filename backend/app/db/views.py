"""PostgreSQL reporting views and read-only ORM mappings."""

from sqlalchemy import (
    BigInteger,
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
)


class VoterChoiceView:
    """A voter's submitted choices, exposed by ``v_voter_choices``."""


class CandidateVotersView:
    """Voters who selected a candidate, exposed by ``v_candidate_voters``."""


class ElectionResultsView:
    """Submitted vote totals, exposed by ``v_results``."""


view_registry.map_imperatively(VoterChoiceView, v_voter_choices_table)
view_registry.map_imperatively(CandidateVotersView, v_candidate_voters_table)
view_registry.map_imperatively(ElectionResultsView, v_results_table)


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
           COUNT(x.vote_id) AS vote_count
    FROM candidates c
    JOIN positions p ON p.id = c.position_id
    LEFT JOIN (
        SELECT vt.id AS vote_id, vt.candidate_id
        FROM votes vt
        JOIN ballots b ON b.id = vt.ballot_id
        WHERE b.status = 'SUBMITTED'
    ) x ON x.candidate_id = c.id
    GROUP BY p.display_order, p.name_en, c.id, c.name_ta, c.name_en
    """,
)

_drop_views = (
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
