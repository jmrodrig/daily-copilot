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


def test_init_db_adds_columns_to_an_existing_table(tmp_path):
    engine = make_engine(f"sqlite:///{(tmp_path / 'copilot.db').as_posix()}")
    try:
        init_db(engine)
        with engine.begin() as conn:
            conn.execute(text('ALTER TABLE "people" DROP COLUMN "is_me"'))
            conn.execute(text("INSERT INTO spaces (id, name) VALUES (1, 'Default')"))
            conn.execute(text("INSERT INTO people (space_id, name, is_external) VALUES (1, 'Zoe', 0)"))
        init_db(engine)  # a database from before `Person.is_me`
        with engine.connect() as conn:
            assert conn.execute(text("SELECT name, is_me FROM people")).all() == [("Zoe", 0)]
            assert {c[1]: c[3] for c in conn.execute(text('PRAGMA table_info("people")'))}["is_me"] == 1  # NOT NULL
    finally:
        engine.dispose()
