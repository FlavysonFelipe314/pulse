from fastapi import APIRouter, Depends, Response
from sqlalchemy import delete, desc, select
from sqlalchemy.orm import Session, selectinload

from app.database import get_db
from app.models import Music, PlaybackHistory, Playlist, PlaylistMusic, User, UserMusic
from app.schemas import HistoryCreate, MusicCreate, MusicOut
from app.services.library_service import add_music, get_music_or_404, serialize_music
from app.services.media_service import delete_media_file
from app.services.auth_service import get_current_user


router = APIRouter(prefix="/library", tags=["library"])


@router.get("", response_model=list[MusicOut])
def list_music(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(Music, UserMusic).join(UserMusic, UserMusic.music_id == Music.id).where(UserMusic.user_id == user.id).order_by(desc(UserMusic.added_at))).all()
    return [serialize_music(music, link) for music, link in rows]


@router.post("", response_model=MusicOut, status_code=201)
def create_music(payload: MusicCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    music = add_music(db, payload, user.id)
    return serialize_music(music, db.get(UserMusic, (user.id, music.id)))


@router.delete("/{music_id}", status_code=204)
def delete_music(music_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    music = get_music_or_404(db, music_id, user.id)
    filename = music.local_filename
    playlist_ids = select(Playlist.id).where(Playlist.user_id == user.id)
    db.execute(delete(PlaylistMusic).where(PlaylistMusic.music_id == music_id, PlaylistMusic.playlist_id.in_(playlist_ids)))
    db.execute(delete(PlaybackHistory).where(PlaybackHistory.user_id == user.id, PlaybackHistory.music_id == music_id))
    link = db.get(UserMusic, (user.id, music_id))
    db.delete(link)
    db.flush()
    still_used = db.scalar(select(UserMusic).where(UserMusic.music_id == music_id).limit(1))
    if not still_used:
        db.delete(music)
    db.commit()
    if not still_used:
        delete_media_file(filename)
    return Response(status_code=204)


@router.patch("/{music_id}/favorite", response_model=MusicOut)
def toggle_favorite(music_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    music = get_music_or_404(db, music_id, user.id)
    link = db.get(UserMusic, (user.id, music_id))
    link.favorite = not link.favorite
    db.commit()
    db.refresh(link)
    return serialize_music(music, link)


@router.post("/history", status_code=201)
def add_history(payload: HistoryCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    get_music_or_404(db, payload.music_id, user.id)
    entry = PlaybackHistory(user_id=user.id, music_id=payload.music_id)
    db.add(entry)
    db.commit()
    return {"id": entry.id}


@router.get("/history/recent", response_model=list[MusicOut])
def recent_history(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(PlaybackHistory).options(selectinload(PlaybackHistory.music)).where(PlaybackHistory.user_id == user.id).order_by(desc(PlaybackHistory.played_at)).limit(30)
    ).all()
    seen: set[int] = set()
    result = []
    for row in rows:
        if row.music_id not in seen:
            seen.add(row.music_id)
            result.append(serialize_music(row.music, db.get(UserMusic, (user.id, row.music_id))))
    return result
