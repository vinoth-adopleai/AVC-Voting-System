"""Initialize missing election database objects at application startup."""

from sqlalchemy import text

from app.db import Base
from app.db.connection import engine
from app.db.views import DASHBOARD_VIEW_DDL


# Serialize create_all across API workers starting against the same database.
_SCHEMA_INIT_LOCK_ID = 741_628_451_031


async def initialize_database() -> None:
    """Create missing tables and apply registered PostgreSQL schema DDL."""
    async with engine.begin() as connection:
        if connection.dialect.name != "postgresql":
            raise RuntimeError("Election schema initialization requires PostgreSQL")

        await connection.execute(
            text("SELECT pg_advisory_xact_lock(:lock_id)"),
            {"lock_id": _SCHEMA_INIT_LOCK_ID},
        )
        await connection.run_sync(Base.metadata.create_all)
        # create_all creates this field for new databases but does not update
        # an existing voters table, so apply this additive change explicitly.
        await connection.execute(
            text("ALTER TABLE voters ADD COLUMN IF NOT EXISTS father_husband_name TEXT")
        )
        await connection.execute(
            text("ALTER TABLE voters ADD COLUMN IF NOT EXISTS thokuthi VARCHAR(100)")
        )
        for statement in DASHBOARD_VIEW_DDL:
            await connection.execute(text(statement))
        await connection.execute(
            text(
                """
                DO $$ BEGIN
                    IF EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = current_schema()
                          AND table_name = 'voters'
                          AND column_name = 'photo_path'
                    ) THEN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = current_schema()
                              AND table_name = 'voters'
                              AND column_name = 'photo'
                        ) THEN
                            UPDATE voters SET photo = COALESCE(photo, photo_path);
                            ALTER TABLE voters DROP COLUMN photo_path;
                        ELSE
                            ALTER TABLE voters RENAME COLUMN photo_path TO photo;
                        END IF;
                    ELSIF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = current_schema()
                          AND table_name = 'voters'
                          AND column_name = 'photo'
                    ) THEN
                        ALTER TABLE voters ADD COLUMN photo TEXT;
                    END IF;
                END $$;
                """
            )
        )
        await connection.execute(text("ALTER TABLE elections ADD COLUMN IF NOT EXISTS start_time TIMESTAMPTZ"))
        await connection.execute(text("ALTER TABLE elections ADD COLUMN IF NOT EXISTS end_time TIMESTAMPTZ"))
        await connection.execute(text(
            """
            DO $$ BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'elections'
                      AND column_name IN ('start_time', 'end_time')
                      AND data_type = 'time without time zone'
                ) THEN
                    ALTER TABLE elections DROP CONSTRAINT IF EXISTS ck_elections_time_range;
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'elections'
                      AND column_name = 'start_time'
                      AND data_type = 'time without time zone'
                ) THEN
                    ALTER TABLE elections ALTER COLUMN start_time TYPE TIMESTAMPTZ
                    USING NULL::TIMESTAMPTZ;
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'elections'
                      AND column_name = 'end_time'
                      AND data_type = 'time without time zone'
                ) THEN
                    ALTER TABLE elections ALTER COLUMN end_time TYPE TIMESTAMPTZ
                    USING NULL::TIMESTAMPTZ;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'ck_elections_time_range'
                ) THEN
                    ALTER TABLE elections
                    ADD CONSTRAINT ck_elections_time_range
                    CHECK (start_time IS NULL OR end_time IS NULL OR end_time > start_time);
                END IF;
            END $$;
            """
        ))

        # Normalize generated system names to one global SYSTEM A{system_no} sequence.
        legacy_systems = await connection.execute(text(
            """
            SELECT id, system_no
            FROM voting_systems
            WHERE name ~ '^(Voting System [0-9]+|SYSTEM [A-Z]+[0-9]+)$'
            ORDER BY system_no
            """
        ))
        for row in legacy_systems:
            new_name = f"SYSTEM A{row.system_no}"
            await connection.execute(
                text("UPDATE voting_systems SET name = :name WHERE id = :system_id"),
                {"name": new_name, "system_id": row.id},
            )
