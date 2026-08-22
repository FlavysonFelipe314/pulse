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
    storage_dir: Path = BASE_DIR / "storage" / "music"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", populate_by_name=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
