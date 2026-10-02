from sqlalchemy import text

from database import init_db, make_engine


def test_init_db_creates_sqlite_file(tmp_path):
    db_file = tmp_path / "nested" / "copilot.db"
    engine = make_engine(f"sqlite:///{db_file.as_posix()}")
    try:
        init_db(engine)
        assert db_file.exists()
        with engine.connect() as conn:
            assert conn.execute(text("PRAGMA foreign_keys")).scalar() == 1
    finally:
        engine.dispose()
