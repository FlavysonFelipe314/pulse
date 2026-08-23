import json

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Setting, User, UserMusic
from app.services.auth_service import get_current_user
from app.schemas import PlaybackState


router = APIRouter(prefix="/player", tags=["player"])


@router.get("/state", response_model=PlaybackState)
def get_state(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    setting = db.get(Setting, f"user:{user.id}:playback_state")
    if not setting:
        return PlaybackState()
    try:
        state = PlaybackState.model_validate_json(setting.value)
        if state.music_id is not None and not db.get(UserMusic, (user.id, state.music_id)):
            state.music_id = None
            state.position = 0
            setting.value = state.model_dump_json()
            db.commit()
        return state
    except ValueError:
        return PlaybackState()


@router.put("/state", response_model=PlaybackState)
def save_state(payload: PlaybackState, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if payload.music_id is not None and not db.get(UserMusic, (user.id, payload.music_id)):
        payload.music_id = None
        payload.position = 0
    key = f"user:{user.id}:playback_state"
    setting = db.get(Setting, key) or Setting(key=key)
    setting.value = payload.model_dump_json()
    db.add(setting)
    db.commit()
    return payload
