from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models import Music, Playlist, PlaylistMusic, UserMusic
from app.schemas import MusicCreate, PlaylistOut


def add_music(db: Session, payload: MusicCreate, user_id: int) -> Music:
    if payload.youtube_video_id:
        existing = db.scalar(select(Music).where(Music.youtube_video_id == payload.youtube_video_id))
        if existing:
            music = existing
        else:
            music = Music(**payload.model_dump())
            db.add(music)
            db.flush()
    else:
        music = Music(**payload.model_dump())
        db.add(music)
        db.flush()
    if not db.get(UserMusic, (user_id, music.id)):
        db.add(UserMusic(user_id=user_id, music_id=music.id))
    db.commit()
    db.refresh(music)
    return music


def get_music_or_404(db: Session, music_id: int, user_id: int) -> Music:
    music = db.get(Music, music_id)
    if not music or not db.get(UserMusic, (user_id, music_id)):
        raise HTTPException(404, "Música não encontrada.")
    return music


def playlist_or_404(db: Session, playlist_id: int, user_id: int) -> Playlist:
    playlist = db.scalar(
        select(Playlist).options(selectinload(Playlist.music_links).selectinload(PlaylistMusic.music)).where(Playlist.id == playlist_id, Playlist.user_id == user_id)
    )
    if not playlist:
        raise HTTPException(404, "Playlist não encontrada.")
    return playlist


def serialize_music(music: Music, link: UserMusic | None = None) -> dict:
    return {
        "id": music.id,
        "title": music.title,
        "artist": music.artist,
        "youtube_video_id": music.youtube_video_id,
        "thumbnail": music.thumbnail,
        "duration_seconds": music.duration_seconds,
        "favorite": link.favorite if link else music.favorite,
        "added_at": link.added_at if link else music.added_at,
        "playable_locally": bool(music.local_filename),
    }


def serialize_playlist(db: Session, playlist: Playlist, user_id: int, include_tracks: bool = True) -> dict:
    tracks = [link.music for link in playlist.music_links]
    user_links = {
        link.music_id: link
        for link in db.scalars(select(UserMusic).where(UserMusic.user_id == user_id, UserMusic.music_id.in_([track.id for track in tracks]))).all()
    } if tracks else {}
    cover = playlist.cover or next((track.thumbnail for track in tracks if track.thumbnail), None)
    return {
        "id": playlist.id,
        "name": playlist.name,
        "description": playlist.description,
        "cover": cover,
        "folder_id": playlist.folder_id,
        "is_public": playlist.is_public,
        "created_at": playlist.created_at,
        "track_count": len(tracks),
        "duration_seconds": sum(track.duration_seconds or 0 for track in tracks),
        "tracks": [serialize_music(track, user_links.get(track.id)) for track in tracks] if include_tracks else [],
    }
