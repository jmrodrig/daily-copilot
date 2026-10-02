"""Application settings loaded from environment variables and `backend/.env`."""

from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="COPILOT_",
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Server
    host: str = "127.0.0.1"
    port: int = 8000

    # Database
    db_path: Path = Path("copilot.db")

    # Markdown file layer (wiki notes, emails)
    notes_dir: Path = Path("notes")

    # Model endpoints
    ollama_base_url: str = "http://localhost:11434"
    # litellm model string used to structure Gantt PDF text (needs gemini_api_key)
    gantt_model: str = "gemini/gemini-3.1-pro-preview"

    # API keys: SecretStr keeps them out of reprs and logs.
    gemini_api_key: SecretStr | None = None
    anthropic_api_key: SecretStr | None = None

    @field_validator("db_path", "notes_dir")
    @classmethod
    def _resolve_path(cls, value: Path) -> Path:
        """Resolve relative paths against backend/, not the current working directory."""
        value = value.expanduser()
        if not value.is_absolute():
            value = BACKEND_DIR / value
        return value.resolve()

    @field_validator("gemini_api_key", "anthropic_api_key", mode="before")
    @classmethod
    def _blank_to_none(cls, value: object) -> object:
        """Treat empty values (e.g. `COPILOT_GEMINI_API_KEY=`) as unset."""
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.db_path.as_posix()}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
