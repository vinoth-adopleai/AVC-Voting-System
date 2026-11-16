"""Database metadata and PostgreSQL-specific schema objects."""

from importlib import import_module

from app.db.models import Base

# Register view and trigger DDL whenever the database package is imported.
import_module("app.db.triggers")
import_module("app.db.views")

__all__ = ["Base"]
