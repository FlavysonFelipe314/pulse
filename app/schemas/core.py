from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator


class MusicBase(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    artist: str = Field(default="Artista desconhecido", min_length=1, max_length=200)
    youtube_video_id: str | None = Field(default=None, min_length=6, max_length=32, pattern=r"^[\w-]+$")
    thumbnail: str | None = Field(default=None, max_length=1000)
    duration_seconds: int | None = Field(default=None, ge=0, le=86400)


class MusicCreate(MusicBase):
    pass


class MusicOut(MusicBase):
    id: int
    favorite: bool
    added_at: datetime
    playable_locally: bool = False
    model_config = ConfigDict(from_attributes=True)


class PlaylistCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    folder_id: int | None = None
    is_public: bool = False

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("Nome obrigatório")
        return value


class PlaylistOut(BaseModel):
    id: int
    name: str
    description: str | None
    cover: str | None
    folder_id: int | None
    is_public: bool
    created_at: datetime
    track_count: int
    duration_seconds: int
    tracks: list[MusicOut] = []


class FolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    parent_id: int | None = None


class FolderOut(FolderCreate):
    id: int
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class HistoryCreate(BaseModel):
    music_id: int


class DownloadCreate(BaseModel):
    track: MusicCreate


class PlaybackState(BaseModel):
    music_id: int | None = None
    position: float = Field(default=0, ge=0)
    volume: float = Field(default=0.75, ge=0, le=1)
    shuffle: bool = False
    repeat_mode: str = Field(default="off", pattern="^(off|one|all)$")


class RegisterCreate(BaseModel):
    display_name: str = Field(min_length=2, max_length=100)
    email: str = Field(min_length=5, max_length=320)
    password: str = Field(min_length=8, max_length=128)


class LoginCreate(BaseModel):
    email: str = Field(min_length=5, max_length=320)
    password: str = Field(min_length=1, max_length=128)


class UserOut(BaseModel):
    id: int
    email: str
    display_name: str
    auto_download_devices: bool
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class UserPreferences(BaseModel):
    auto_download_devices: bool


class PublicUserOut(BaseModel):
    id: int
    display_name: str
    friendship_status: str | None = None


class RoomCreate(BaseModel):
    name: str = Field(default="Sala de música", min_length=2, max_length=80)
    queue_policy: Literal["everyone", "approval", "host_only"] = "everyone"


class RoomJoin(BaseModel):
    code: str = Field(min_length=4, max_length=10, pattern=r"^[A-Za-z0-9]+$")
