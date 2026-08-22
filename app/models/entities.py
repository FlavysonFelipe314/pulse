from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Table, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class PlaylistMusic(Base):
    __tablename__ = "playlist_music"
    __table_args__ = (UniqueConstraint("playlist_id", "music_id"),)

    playlist_id: Mapped[int] = mapped_column(ForeignKey("playlists.id", ondelete="CASCADE"), primary_key=True)
    music_id: Mapped[int] = mapped_column(ForeignKey("music.id", ondelete="CASCADE"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    music: Mapped["Music"] = relationship(back_populates="playlist_links")
    playlist: Mapped["Playlist"] = relationship(back_populates="music_links")


class Music(Base):
    __tablename__ = "music"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(300))
    artist: Mapped[str] = mapped_column(String(200), default="Artista desconhecido")
    youtube_video_id: Mapped[str | None] = mapped_column(String(32), unique=True, nullable=True)
    thumbnail: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    local_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    playlist_links: Mapped[list[PlaylistMusic]] = relationship(back_populates="music", cascade="all, delete-orphan")


class Folder(Base):
    __tablename__ = "folders"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("folders.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    playlists: Mapped[list["Playlist"]] = relationship(back_populates="folder")


class Playlist(Base):
    __tablename__ = "playlists"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    cover: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    folder_id: Mapped[int | None] = mapped_column(ForeignKey("folders.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    folder: Mapped[Folder | None] = relationship(back_populates="playlists")
    music_links: Mapped[list[PlaylistMusic]] = relationship(
        back_populates="playlist", cascade="all, delete-orphan", order_by="PlaylistMusic.position"
    )


class PlaybackHistory(Base):
    __tablename__ = "playback_history"

    id: Mapped[int] = mapped_column(primary_key=True)
    music_id: Mapped[int] = mapped_column(ForeignKey("music.id", ondelete="CASCADE"), index=True)
    played_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    music: Mapped[Music] = relationship()


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")

