import json

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Setting
from app.schemas import PlaybackState


router = APIRouter(prefix="/player", tags=["player"])


@router.get("/state", response_model=PlaybackState)
def get_state(db: Session = Depends(get_db)):
    setting = db.get(Setting, "playback_state")
    if not setting:
        return PlaybackState()
    try:
        return PlaybackState.model_validate_json(setting.value)
    except ValueError:
        return PlaybackState()


@router.put("/state", response_model=PlaybackState)
def save_state(payload: PlaybackState, db: Session = Depends(get_db)):
    setting = db.get(Setting, "playback_state") or Setting(key="playback_state")
    setting.value = payload.model_dump_json()
    db.add(setting)
    db.commit()
    return payload

