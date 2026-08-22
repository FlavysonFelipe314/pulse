from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models import Music, PlaybackHistory, Playlist, PlaylistMusic
from app.schemas import MusicCreate, PlaylistOut


def add_music(db: Session, payload: MusicCreate) -> Music:
    if payload.youtube_video_id:
        existing = db.scalar(select(Music).where(Music.youtube_video_id == payload.youtube_video_id))
        if existing:
            return existing
    music = Music(**payload.model_dump())
    db.add(music)
    db.commit()
    db.refresh(music)
    return music


def get_music_or_404(db: Session, music_id: int) -> Music:
    music = db.get(Music, music_id)
    if not music:
        raise HTTPException(404, "Música não encontrada.")
    return music


def playlist_or_404(db: Session, playlist_id: int) -> Playlist:
    playlist = db.scalar(
        select(Playlist).options(selectinload(Playlist.music_links).selectinload(PlaylistMusic.music)).where(Playlist.id == playlist_id)
    )
    if not playlist:
        raise HTTPException(404, "Playlist não encontrada.")
    return playlist


def serialize_music(music: Music) -> dict:
    return {
        "id": music.id,
        "title": music.title,
        "artist": music.artist,
        "youtube_video_id": music.youtube_video_id,
        "thumbnail": music.thumbnail,
        "duration_seconds": music.duration_seconds,
        "favorite": music.favorite,
        "added_at": music.added_at,
        "playable_locally": bool(music.local_filename),
    }


def serialize_playlist(playlist: Playlist, include_tracks: bool = True) -> dict:
    tracks = [link.music for link in playlist.music_links]
    cover = playlist.cover or next((track.thumbnail for track in tracks if track.thumbnail), None)
    return {
        "id": playlist.id,
        "name": playlist.name,
        "description": playlist.description,
        "cover": cover,
        "folder_id": playlist.folder_id,
        "created_at": playlist.created_at,
        "track_count": len(tracks),
        "duration_seconds": sum(track.duration_seconds or 0 for track in tracks),
        "tracks": [serialize_music(track) for track in tracks] if include_tracks else [],
    }

