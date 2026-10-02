"""SQLAlchemy engine, session factory and declarative base for the SQLite store."""

from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from config import get_settings


class Base(DeclarativeBase):
    """Base class for ORM models (defined in `models`)."""


def make_engine(database_url: str) -> Engine:
    engine = create_engine(
        database_url,
        # FastAPI may use a session from a different thread than the one that created it.
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    return engine


engine = make_engine(get_settings().database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db(bind: Engine = engine) -> None:
    """Create the database file and any missing tables."""
    import models  # noqa: F401  -- registers the ORM tables on Base.metadata

    db_file = bind.url.database
    if db_file and db_file != ":memory:":
        Path(db_file).parent.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(bind=bind)


def get_db() -> Iterator[Session]:
    """FastAPI dependency yielding a session that is always closed afterwards."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
