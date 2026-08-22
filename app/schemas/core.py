from datetime import datetime

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
    rights_confirmed: bool


class PlaybackState(BaseModel):
    music_id: int | None = None
    position: float = Field(default=0, ge=0)
    volume: float = Field(default=0.75, ge=0, le=1)
    shuffle: bool = False
    repeat_mode: str = Field(default="off", pattern="^(off|one|all)$")
