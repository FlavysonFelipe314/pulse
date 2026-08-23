from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Music, User, UserMusic
from app.services.auth_service import get_current_user
from app.services.lyrics_service import get_or_fetch_lyrics
from app.services.room_service import can_access_room_media


router = APIRouter(prefix="/lyrics", tags=["lyrics"])


@router.get("/{music_id}")
def lyrics(
    music_id: int,
    room: str | None = Query(default=None, max_length=10),
    refresh: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    music = db.get(Music, music_id)
    owns_music = bool(db.get(UserMusic, (user.id, music_id)))
    room_access = bool(room and can_access_room_media(room, user.id, music_id))
    if not music or not (owns_music or room_access):
        raise HTTPException(404, "Letra não disponível.")
    return get_or_fetch_lyrics(db, music, refresh=refresh)
