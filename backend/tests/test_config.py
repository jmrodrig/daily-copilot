from pathlib import Path

from config import BACKEND_DIR, Settings


def test_default_db_path_resolves_to_backend_dir(monkeypatch, tmp_path):
    monkeypatch.delenv("COPILOT_DB_PATH", raising=False)
    monkeypatch.chdir(tmp_path)
    settings = Settings(_env_file=None)
    assert settings.db_path == (BACKEND_DIR / "copilot.db").resolve()


def test_relative_db_path_is_relative_to_backend_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("COPILOT_DB_PATH", "data/test.db")
    monkeypatch.chdir(tmp_path)
    settings = Settings(_env_file=None)
    assert settings.db_path == (BACKEND_DIR / "data" / "test.db").resolve()


def test_absolute_db_path_is_kept(monkeypatch, tmp_path):
    target = tmp_path / "abs.db"
    monkeypatch.setenv("COPILOT_DB_PATH", str(target))
    settings = Settings(_env_file=None)
    assert settings.db_path == target.resolve()
    assert settings.database_url == f"sqlite:///{target.resolve().as_posix()}"


def test_api_keys_loaded_from_env_and_hidden(monkeypatch):
    monkeypatch.setenv("COPILOT_GEMINI_API_KEY", "secret-value")
    settings = Settings(_env_file=None)
    assert settings.gemini_api_key.get_secret_value() == "secret-value"
    assert "secret-value" not in repr(settings)


def test_missing_or_blank_api_keys_are_none(monkeypatch):
    monkeypatch.delenv("COPILOT_GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("COPILOT_ANTHROPIC_API_KEY", "")
    settings = Settings(_env_file=None)
    assert settings.gemini_api_key is None
    assert settings.anthropic_api_key is None


def test_env_file_is_read(tmp_path, monkeypatch):
    monkeypatch.delenv("COPILOT_GEMINI_API_KEY", raising=False)
    env_file = tmp_path / ".env"
    env_file.write_text("COPILOT_GEMINI_API_KEY=from-file\nCOPILOT_PORT=9000\n")
    settings = Settings(_env_file=Path(env_file))
    assert settings.gemini_api_key.get_secret_value() == "from-file"
    assert settings.port == 9000
