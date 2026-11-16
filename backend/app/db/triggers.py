"""PostgreSQL-only ballot and audit immutability triggers."""

from sqlalchemy import DDL, event

from app.db.models import Base


_create_functions = (
    """
    CREATE OR REPLACE FUNCTION check_ballot_counts() RETURNS trigger AS $$
    DECLARE
        bad RECORD;
        total INT;
        want INT;
    BEGIN
        SELECT p.name_en INTO bad
        FROM positions p
        LEFT JOIN votes v ON v.position_id = p.id AND v.ballot_id = NEW.id
        WHERE p.election_id = NEW.election_id
        GROUP BY p.id
        HAVING COUNT(v.id) NOT BETWEEN p.min_choices AND p.max_choices
        LIMIT 1;

        IF FOUND THEN
            RAISE EXCEPTION USING MESSAGE = concat(
                'Invalid vote count for position: ', bad.name_en
            );
        END IF;

        SELECT COUNT(*) INTO total FROM votes WHERE ballot_id = NEW.id;
        SELECT ballot_total INTO want FROM elections WHERE id = NEW.election_id;

        IF total <> want THEN
            RAISE EXCEPTION USING MESSAGE = concat(
                'Ballot must contain exactly ', want, ' votes, found ', total
            );
        END IF;
        RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
    """,
    """
    CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger AS $$
    BEGIN
        RAISE EXCEPTION USING MESSAGE = concat(TG_OP, ' on ', TG_TABLE_NAME, ' is not allowed');
    END;
    $$ LANGUAGE plpgsql
    """,
    """
    CREATE OR REPLACE FUNCTION guard_ballot_change() RETURNS trigger AS $$
    BEGIN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'Ballots cannot be deleted';
        END IF;
        IF OLD.status = 'SUBMITTED' AND NEW.status = 'VOID'
           AND NEW.id = OLD.id
           AND NEW.election_id = OLD.election_id
           AND NEW.voter_id = OLD.voter_id
           AND NEW.system_id = OLD.system_id
           AND NEW.authorized_by = OLD.authorized_by
           AND NEW.submitted_at = OLD.submitted_at THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'A ballot can only be changed from SUBMITTED to VOID';
    END;
    $$ LANGUAGE plpgsql
    """,
)

_create_triggers = (
    "DROP TRIGGER IF EXISTS trg_ballot_counts ON ballots",
    """
    CREATE CONSTRAINT TRIGGER trg_ballot_counts
    AFTER INSERT ON ballots DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_ballot_counts()
    """,
    "DROP TRIGGER IF EXISTS trg_votes_immutable ON votes",
    """
    CREATE TRIGGER trg_votes_immutable BEFORE UPDATE OR DELETE ON votes
    FOR EACH ROW EXECUTE FUNCTION forbid_change()
    """,
    "DROP TRIGGER IF EXISTS trg_ballots_guard ON ballots",
    """
    CREATE TRIGGER trg_ballots_guard BEFORE UPDATE OR DELETE ON ballots
    FOR EACH ROW EXECUTE FUNCTION guard_ballot_change()
    """,
    "DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_logs",
    """
    CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION forbid_change()
    """,
)

_drop_triggers = (
    "DROP TRIGGER IF EXISTS trg_ballot_counts ON ballots",
    "DROP TRIGGER IF EXISTS trg_votes_immutable ON votes",
    "DROP TRIGGER IF EXISTS trg_ballots_guard ON ballots",
    "DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_logs",
)

_drop_functions = (
    "DROP FUNCTION IF EXISTS guard_ballot_change()",
    "DROP FUNCTION IF EXISTS forbid_change()",
    "DROP FUNCTION IF EXISTS check_ballot_counts()",
)

event.listen(
    Base.metadata,
    "before_create",
    DDL("CREATE EXTENSION IF NOT EXISTS pg_trgm").execute_if(dialect="postgresql"),
)

for _statement in _create_functions + _create_triggers:
    event.listen(
        Base.metadata,
        "after_create",
        DDL(_statement).execute_if(dialect="postgresql"),
    )

for _statement in _drop_triggers + _drop_functions:
    event.listen(
        Base.metadata,
        "before_drop",
        DDL(_statement).execute_if(dialect="postgresql"),
    )
