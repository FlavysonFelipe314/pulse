from fastapi import APIRouter, Depends, Response
from sqlalchemy import desc, select
from sqlalchemy.orm import Session, selectinload

from app.database import get_db
from app.models import Music, PlaybackHistory
from app.schemas import HistoryCreate, MusicCreate, MusicOut
from app.services.library_service import add_music, get_music_or_404, serialize_music
from app.services.media_service import delete_media_file


router = APIRouter(prefix="/library", tags=["library"])


@router.get("", response_model=list[MusicOut])
def list_music(db: Session = Depends(get_db)):
    return [serialize_music(item) for item in db.scalars(select(Music).order_by(desc(Music.added_at))).all()]


@router.post("", response_model=MusicOut, status_code=201)
def create_music(payload: MusicCreate, db: Session = Depends(get_db)):
    return serialize_music(add_music(db, payload))


@router.delete("/{music_id}", status_code=204)
def delete_music(music_id: int, db: Session = Depends(get_db)):
    music = get_music_or_404(db, music_id)
    filename = music.local_filename
    db.delete(music)
    db.commit()
    delete_media_file(filename)
    return Response(status_code=204)


@router.patch("/{music_id}/favorite", response_model=MusicOut)
def toggle_favorite(music_id: int, db: Session = Depends(get_db)):
    music = get_music_or_404(db, music_id)
    music.favorite = not music.favorite
    db.commit()
    db.refresh(music)
    return serialize_music(music)


@router.post("/history", status_code=201)
def add_history(payload: HistoryCreate, db: Session = Depends(get_db)):
    get_music_or_404(db, payload.music_id)
    entry = PlaybackHistory(music_id=payload.music_id)
    db.add(entry)
    db.commit()
    return {"id": entry.id}


@router.get("/history/recent", response_model=list[MusicOut])
def recent_history(db: Session = Depends(get_db)):
    rows = db.scalars(
        select(PlaybackHistory).options(selectinload(PlaybackHistory.music)).order_by(desc(PlaybackHistory.played_at)).limit(30)
    ).all()
    seen: set[int] = set()
    result = []
    for row in rows:
        if row.music_id not in seen:
            seen.add(row.music_id)
            result.append(serialize_music(row.music))
    return result
