import sys
from pathlib import Path

# Make backend modules (main, config, database) importable as top-level modules,
# matching how uvicorn runs them from backend/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

import database  # noqa: E402
import spaces  # noqa: E402
from config import Settings  # noqa: E402


@pytest.fixture(autouse=True)
def data_dirs(tmp_path, monkeypatch):
    """Point the spaces (and the legacy notes folder the startup migration moves) at tmp_path,
    so no test ever touches the real `data/` or `notes/` folders."""
    settings = Settings(_env_file=None, data_dir=tmp_path / "data", notes_dir=tmp_path / "legacy-notes")
    monkeypatch.setattr(spaces, "get_settings", lambda: settings)
    return settings


@pytest.fixture
def notes_dir():
    """The Default space's content/ folder (under tmp_path, see conftest)."""
    root = spaces.content_dir(spaces.DEFAULT_SPACE_ID)
    root.mkdir(parents=True)
    return root


@pytest.fixture(autouse=True)
def default_db(tmp_path, monkeypatch):
    """Point the default engine/session at a throwaway database, never the real copilot.db.

    The file layer records note history through `database.SessionLocal`.
    """
    engine = database.make_engine(f"sqlite:///{(tmp_path / 'default.db').as_posix()}")
    database.init_db(engine)
    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(database, "SessionLocal", sessionmaker(bind=engine, autoflush=False, expire_on_commit=False))
    yield engine
    engine.dispose()
