from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parent


class Settings(BaseSettings):
    app_name: str = Field(default="Pulse", validation_alias=AliasChoices("PULSE_APP_NAME"))
    debug_mode: bool = Field(default=False, validation_alias=AliasChoices("PULSE_DEBUG"))
    database_url: str = Field(default="sqlite:///./pulse.db", validation_alias=AliasChoices("DATABASE_URL", "PULSE_DATABASE_URL"))
    youtube_api_key: str = Field(default="", validation_alias=AliasChoices("YOUTUBE_API_KEY", "PULSE_YOUTUBE_API_KEY"))
    lrclib_user_agent: str = Field(default="Pulse/1.0 (contact: pulse-local@example.invalid)", validation_alias=AliasChoices("LRCLIB_USER_AGENT"))
    server_host: str = Field(default="0.0.0.0", validation_alias=AliasChoices("PULSE_HOST"))
    server_port: int = Field(default=8000, validation_alias=AliasChoices("PULSE_PORT"))
    storage_dir: Path = BASE_DIR / "storage" / "music"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", populate_by_name=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
