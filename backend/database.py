"""SQLAlchemy engine, session factory and declarative base for the SQLite store."""

from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine, event, inspect, text
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
    """Create the database file and any missing tables and columns."""
    import models  # noqa: F401  -- registers the ORM tables and the history listeners

    db_file = bind.url.database
    if db_file and db_file != ":memory:":
        Path(db_file).parent.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(bind=bind)
    _add_missing_columns(bind)


def _add_missing_columns(bind: Engine) -> None:
    """Add nullable columns introduced after a table was created (e.g. `deleted_at`).

    `create_all` only creates missing tables, so databases from earlier phases need this.
    """
    inspector = inspect(bind)
    with bind.begin() as conn:
        for table in Base.metadata.sorted_tables:
            existing = {column["name"] for column in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in existing:
                    continue
                if not column.nullable:
                    raise RuntimeError(f"Cannot add NOT NULL column {table.name}.{column.name} to an existing database")
                column_type = column.type.compile(dialect=bind.dialect)
                conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {column_type}'))
                for index in table.indexes:
                    if [c.name for c in index.columns] == [column.name]:
                        index.create(conn, checkfirst=True)


def get_db() -> Iterator[Session]:
    """FastAPI dependency yielding a session that is always closed afterwards."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
